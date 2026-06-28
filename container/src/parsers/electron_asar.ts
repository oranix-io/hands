/**
 * Electron asar parser — extracts metadata from an Electron `app.asar` archive
 * inside an Electron install bundle (zip wrapper used by `electron-builder`,
 * or raw .asar file).
 *
 * v1 strategy:
 *   1. If the input is a raw asar file (magic 4-byte size + JSON header),
 *      parse the header directly.
 *   2. If the input is a zip, walk the central directory for an entry whose
 *      name ends in "/app.asar" or is "app.asar", then stream-extract that
 *      entry's bytes and parse the asar header from them.
 *   3. The asar header is a JSON object `{ files: { "key": { "size", "offset", ... } } }`
 *      where keys are paths inside the bundle (e.g. "package.json").
 *   4. Pull `package.json` from the asar (offset = header.files["package.json"].offset,
 *      size = header.files["package.json"].size) and JSON.parse it for
 *      name / version.
 *
 * Doesn't yet handle nested asar archives (app.asar inside another asar);
 * that requires iterating. v2.
 */

import { sha256Hex } from "./index.js";
import type { ParsedMetadata } from "./index.js";

const ZIP_EOCD_SIG = [0x50, 0x4b, 0x05, 0x06];

export async function parseElectronAsar(
  bytes: Uint8Array,
  filePath: string | null,
): Promise<ParsedMetadata> {
  if (looksLikeRawAsar(bytes)) {
    return parseRawAsar(bytes, filePath);
  }
  if (looksLikeZip(bytes)) {
    const asarBytes = await extractAsarFromZip(bytes);
    if (asarBytes) return parseRawAsar(asarBytes, filePath);
  }
  throw new Error(
    "not a recognized Electron bundle (expected raw .asar or zip with app.asar)",
  );
}

function looksLikeRawAsar(b: Uint8Array): boolean {
  // asar magic: first 4 bytes = pickled header size (uint32 LE), then
  // that many bytes of pickled JSON. The pickled JSON, when un-pickled,
  // is { files: ... }.
  if (b.length < 8) return false;
  const size =
    b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24);
  return size > 0 && size < b.length - 4 && size < 10 * 1024 * 1024;
}

function looksLikeZip(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05) &&
    (b[3] === 0x04 || b[3] === 0x06)
  );
}

interface AsarHeader {
  files?: Record<string, AsarEntry>;
}

interface AsarEntry {
  size?: number;
  offset?: string; // asar uses decimal strings
  files?: Record<string, AsarEntry>;
}

function parseRawAsar(bytes: Uint8Array, filePath: string | null): ParsedMetadata {
  const headerSize =
    bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24);
  if (headerSize <= 0 || headerSize + 4 > bytes.length) {
    throw new Error("asar header size out of range");
  }
  const headerBytes = bytes.subarray(4, 4 + headerSize);
  // asar uses JSON.stringify (not pickled) — the magic is just the size prefix.
  const headerText = new TextDecoder("utf-8", { fatal: false }).decode(
    headerBytes,
  );
  let header: AsarHeader;
  try {
    header = JSON.parse(headerText);
  } catch (e) {
    throw new Error(
      `failed to parse asar header as JSON: ${(e as Error).message}`,
    );
  }
  const files = header.files ?? {};
  const pkgEntry = files["package.json"];
  let pkgJson: Record<string, unknown> = {};
  if (pkgEntry && pkgEntry.offset !== undefined && pkgEntry.size !== undefined) {
    const off = Number(pkgEntry.offset);
    const size = Number(pkgEntry.size);
    const start = headerSize + 4 + off;
    const end = start + size;
    if (end <= bytes.length) {
      try {
        const pkgText = new TextDecoder("utf-8", { fatal: false }).decode(
          bytes.subarray(start, end),
        );
        pkgJson = JSON.parse(pkgText);
      } catch {
        // ignore malformed package.json
      }
    }
  }

  const name = (pkgJson.name as string) ?? null;
  const version = (pkgJson.version as string) ?? null;
  const arch = (pkgJson.arch as string) ?? null;

  // Detect platform from filename if provided.
  const filename = (filePath ?? "").toLowerCase();
  let platform = "unknown";
  if (filename.includes("darwin") || filename.endsWith(".dmg") || filename.endsWith(".pkg")) {
    platform = "darwin";
  } else if (filename.includes("linux") || filename.endsWith(".deb") || filename.endsWith(".AppImage")) {
    platform = "linux";
  } else if (filename.includes("win32") || filename.includes("windows") || filename.endsWith(".exe") || filename.endsWith(".msi")) {
    platform = "win32";
  }

  return {
    parser_kind: "electron-asar",
    platform,
    arch,
    version,
    version_code: null,
    package_id: name,
    app_label: null,
    size_bytes: bytes.byteLength,
    file_hash_sha256: sha256Hex(bytes),
    raw: {
      asar_files_count: Object.keys(files).length,
      package_name: name,
      package_main: pkgJson.main ?? null,
      electron_version: pkgJson.electronVersion ?? null,
    },
  };
}

/**
 * Walk a zip's central directory looking for an asar entry. Streams out the
 * matching entry's bytes using stored (uncompressed) zip or, if deflated,
 * attempts raw inflate via a built-in path.
 *
 * v1 only handles STORED (compression=0) asar entries inside zip wrappers,
 * which covers the common `electron-builder` zip output. For DEFLATE
 * entries, we return null and let the caller surface "asar inside zip is
 * compressed" — they'll need to re-zip with -0 or use a richer parser.
 */
async function extractAsarFromZip(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  // Find EOCD
  let eocd = -1;
  outer: for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      bytes[i] === ZIP_EOCD_SIG[0] &&
      bytes[i + 1] === ZIP_EOCD_SIG[1] &&
      bytes[i + 2] === ZIP_EOCD_SIG[2] &&
      bytes[i + 3] === ZIP_EOCD_SIG[3]
    ) {
      eocd = i;
      break outer;
    }
  }
  if (eocd < 0) return null;

  const totalEntries =
    bytes[eocd + 10]! | (bytes[eocd + 11]! << 8);
  const cdSize =
    (bytes[eocd + 12]! |
      (bytes[eocd + 13]! << 8) |
      (bytes[eocd + 14]! << 16) |
      (bytes[eocd + 15]! << 24)) >>>
    0;
  const cdOffset =
    (bytes[eocd + 16]! |
      (bytes[eocd + 17]! << 8) |
      (bytes[eocd + 18]! << 16) |
      (bytes[eocd + 19]! << 24)) >>>
    0;

  // Walk central directory entries looking for /app.asar or app.asar.
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > bytes.length) break;
    const sig = bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16) | (bytes[p + 3]! << 24);
    if (sig !== 0x02014b50) break; // CDH signature
    const method =
      bytes[p + 10]! | (bytes[p + 11]! << 8);
    const compSize =
      bytes[p + 20]! |
      (bytes[p + 21]! << 8) |
      (bytes[p + 22]! << 16) |
      (bytes[p + 23]! << 24);
    const uncompSize =
      bytes[p + 24]! |
      (bytes[p + 25]! << 8) |
      (bytes[p + 26]! << 16) |
      (bytes[p + 27]! << 24);
    const nameLen =
      bytes[p + 28]! | (bytes[p + 29]! << 8);
    const extraLen =
      bytes[p + 30]! | (bytes[p + 31]! << 8);
    const commentLen =
      bytes[p + 32]! | (bytes[p + 33]! << 8);
    const localHeaderOffset =
      bytes[p + 42]! |
      (bytes[p + 43]! << 8) |
      (bytes[p + 44]! << 16) |
      (bytes[p + 45]! << 24);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(
      bytes.subarray(p + 46, p + 46 + nameLen),
    );
    const isAsar = /(^|\/)app\.asar$/.test(name);
    if (isAsar) {
      // Read local file header to get the data offset (after the local entry's name + extra).
      const lh = localHeaderOffset;
      const lhNameLen = bytes[lh + 26]! | (bytes[lh + 27]! << 8);
      const lhExtraLen = bytes[lh + 28]! | (bytes[lh + 29]! << 8);
      const dataStart = lh + 30 + lhNameLen + lhExtraLen;
      if (method === 0) {
        return bytes.subarray(dataStart, dataStart + uncompSize);
      }
      // DEFLATE: try to inflate. Node 22 has Decompress via stream but for
      // a quick v1 we just refuse.
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
