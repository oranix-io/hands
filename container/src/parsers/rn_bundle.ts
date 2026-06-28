/**
 * RN bundle parser — extracts metadata from a React Native Metro bundle.
 *
 * RN bundles are a series of `__d(function(...){...}, <id>, [<deps>])`
 * defines. The bundle typically starts with `__d(function(global,require,...)
 * {` and the first few hundred bytes contain enough to identify the bundle
 * version + engine.
 *
 * v1 of this parser extracts:
 *   - version (best-effort: looks for __BUNDLE_START_TIME__ comment or
 *     `reactNativeVersion` field)
 *   - target_app_version (e.g. "1.2.3") from comments / headers
 *   - size + sha256
 *
 * Heuristic-based; no full JS parser. Good enough for build_assets.fingerprint
 * and admin UI display. v2 may swap for an AST-based parser.
 */

import { sha256Hex } from "./index.js";
import type { ParsedMetadata } from "./index.js";

const HEAD_BYTES = 64 * 1024;

export function parseRnBundle(bytes: Uint8Array): ParsedMetadata {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, Math.min(bytes.length, HEAD_BYTES)),
  );

  // Common RN bundle headers / comments — extract via regex.
  const version =
    extractFirst(
      head,
      [
        /reactNativeVersion\s*=\s*["']([^"']+)["']/,
        /__BUNDLE_VERSION__\s*=\s*["']([^"']+)["']/,
        /__REACT_NATIVE_VERSION__\s*=\s*["']([^"']+)["']/,
        /\bversion\s*[:=]\s*["']([\d.]+)["']/,
      ],
    ) ?? null;

  const targetAppVersion =
    extractFirst(head, [
      /targetAppVersion\s*[:=]\s*["']([^"']+)["']/,
      /appVersion\s*[:=]\s*["']([^"']+)["']/,
      /\bapp_version\s*[:=]\s*["']([\d.]+)["']/,
    ]) ?? null;

  // Fingerprint: hash the first 8 KiB + tail 8 KiB. Same bundle uploaded
  // twice will have the same fingerprint regardless of metadata changes.
  const sampleSize = Math.min(8192, bytes.length);
  const headSample = bytes.subarray(0, sampleSize);
  const tailSample = bytes.subarray(bytes.length - sampleSize);
  const fingerprint = sha256Hex(
    concat(headSample, tailSample),
  );

  return {
    parser_kind: "rn-bundle",
    platform: "rn-bundle",
    arch: null,
    version,
    version_code: null,
    package_id: null,
    app_label: null,
    size_bytes: bytes.byteLength,
    file_hash_sha256: sha256Hex(bytes),
    raw: {
      target_app_version: targetAppVersion,
      fingerprint,
    },
  };
}

function extractFirst(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
