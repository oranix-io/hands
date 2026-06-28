/**
 * CLI binary parser — extracts version + arch from a single-file ELF.
 *
 * v1 supports Linux ELF (the most common CLI distribution format).
 * Reads:
 *   - ELF header (e_ident + e_machine) → arch
 *   - .rodata for a version-ish string ("v1.2.3", "1.2.3", "version 1.2.3")
 * v2 may add Mach-O (macOS) and PE (Windows).
 */

import { sha256Hex } from "./index.js";
import type { ParsedMetadata } from "./index.js";

const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const ELFDATA2MSB = 2;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const EM_386 = 3;
const EM_ARM = 40;
const EM_RISCV = 243;

const SEMVER_RE = /\b(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;
const VERSION_HINT_RE = /(?:^|\s|["'`])(version|ver|release|build)?\s*[":=]?\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i;

export function parseCliBinary(bytes: Uint8Array): ParsedMetadata {
  if (bytes.length < 64 || !isElf(bytes)) {
    throw new Error("not an ELF binary");
  }
  const elfClass = bytes[4]!;
  const elfData = bytes[5]!;
  if (elfClass !== ELFCLASS32 && elfClass !== ELFCLASS64) {
    throw new Error(`unsupported ELF class ${elfClass}`);
  }
  if (elfData !== ELFDATA2LSB && elfData !== ELFDATA2MSB) {
    throw new Error(`unsupported ELF endianness ${elfData}`);
  }
  const little = elfData === ELFDATA2LSB;
  const arch = readArch(bytes, little);

  const scanEnd = Math.min(bytes.length, 1024 * 1024);
  const version = findSemverInAscii(bytes.subarray(0, scanEnd));

  return {
    parser_kind: "cli-binary",
    platform: "linux",
    arch,
    version,
    version_code: null,
    package_id: null,
    app_label: null,
    size_bytes: bytes.byteLength,
    file_hash_sha256: sha256Hex(bytes),
    raw: {
      elf_class: elfClass === ELFCLASS64 ? "64" : "32",
      elf_endian: little ? "le" : "be",
    },
  };
}

function isElf(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x7f &&
    b[1] === 0x45 &&
    b[2] === 0x4c &&
    b[3] === 0x46
  );
}

function readArch(b: Uint8Array, little: boolean): string | null {
  // e_machine is at offset 18 in ELF32 + ELF64 (same offset).
  const off = 18;
  if (b.length < off + 2) return null;
  const machine = little
    ? b[off]! | (b[off + 1]! << 8)
    : (b[off]! << 8) | b[off + 1]!;
  switch (machine) {
    case EM_X86_64:
      return "x64";
    case EM_AARCH64:
      return "arm64";
    case EM_386:
      return "x86";
    case EM_ARM:
      return "arm";
    case EM_RISCV:
      return "riscv64";
    default:
      return `e_machine_${machine}`;
  }
}

/**
 * Scan printable ASCII runs in `buf` for a semver-looking substring.
 * Restricts to runs of length ≥6 to skip random binary noise; prefers runs
 * that include "version" / "ver" / "release" hints.
 */
interface VersionMatch {
  v: string;
  score: number;
  pos: number;
}

function findSemverInAscii(buf: Uint8Array): string | null {
  let best: VersionMatch | null = null;
  let runStart = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    const printable = c >= 0x20 && c <= 0x7e;
    if (!printable) {
      if (runStart >= 0) {
        const candidate = scanRun(buf, runStart, i - runStart);
        if (candidate && (!best || candidate.score > best.score)) {
          best = candidate;
        }
        runStart = -1;
      }
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  if (runStart >= 0) {
    const candidate = scanRun(buf, runStart, buf.length - runStart);
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }
  return best?.v ?? null;
}

function scanRun(
  buf: Uint8Array,
  start: number,
  len: number,
): VersionMatch | null {
  if (len < 4 || len > 256) return null;
  const slice = buf.subarray(start, start + len);
  const text = String.fromCharCode(...slice);
  // Prefer matches that include a "version"/"ver"/"release" hint.
  const hint = VERSION_HINT_RE.exec(text);
  if (hint) {
    return { v: hint[2]!, score: 10 + (hint[1] ? 5 : 0), pos: start };
  }
  // Otherwise match raw semver if the run is short (less random).
  const m = SEMVER_RE.exec(text);
  if (m && len <= 32) {
    return { v: m[1]!, score: 1, pos: start };
  }
  return null;
}
