# Delta (differential) update download — design

Task #246. Today the Hands Android SDK downloads the **full APK** on every
update (`UpdateChecker` → signed R2 URL → `DownloadManager` → installer).
This wastes bandwidth: most releases change a small fraction of the APK, yet
users re-download all of it (a 1.3.0 APK is tens of MB). Delta download ships
only the difference between the installed version and the new one.

Scope boundary with **#245** (Raft Android Steward): #245 owns the
client-build wins. Per AD2's measurements on 1.3.0 (correcting an earlier
estimate): ABI filtering (PR #542) trims ~16% (26.8→22.8 MB) and is
independent — land it first. Note two things it does *not* buy us: 1.3.0's
APK no longer carries `libnetworkkmmcurl.so`, and native libs are already
compressed via `useLegacyPackaging=true` — so the x86/x86_64 redundancy is
sub-MB (not the ~8 MB first guessed), and turning `useLegacyPackaging` off
would *increase* download size, not shrink it. The main update-experience
lever is therefore this **delta capability** (server produces patches, SDK
applies them) — the larger, cross-cutting win.

## Recommended tool: Google archive-patcher

Do **not** use raw bsdiff on the whole APK. An APK is a ZIP of DEFLATE-
compressed entries; a one-byte source change perturbs the whole compressed
stream, so whole-file bsdiff produces large, unstable patches. Google's
[archive-patcher](https://github.com/google/archive-patcher) — the engine
behind Play Store's delta updates — is **file-by-file**: it decompresses
matching entries, diffs the uncompressed bytes (bsdiff internally), and
records how to recompress deterministically. Benefits for us:

- **Pure Java, no NDK** on the client (just a library dependency) — nothing to
  cross-compile per ABI.
- APK/ZIP-aware, so deltas track the *actual* change, not compression noise.
- Same generator runs in CI (JVM) to produce patches.

## Architecture

### 1. Patch generation (CI, at publish time)
When a new version is published, generate patches **from the last N published
versions** to the new one, per arch (matching how we already split assets by
`arch`). N bounds the cost: a full patch matrix is O(N²) storage; cap N at 3–5
(covers the vast majority of active installs; anyone older falls back to full).

- New CLI step (or `publish-android` extension): for each `(prev_apk,
  new_apk)` pair the generator emits `patch-<from_vc>-to-<to_vc>-<arch>.patch`.
- Upload as build assets with `artifact_kind = 'delta-patch'` and
  `metadata_json = {from_version_code, to_version_code, algorithm:
  "archive-patcher-v1"}`; store `file_hash` (patch sha256) and the **target
  APK sha256** so the client can verify the reconstructed file.

### 2. Server (`/updates/check`)
Response is unchanged for clients with no applicable patch (full `download_url`
stays the fallback, always present). When the client sends `current_version_code`
+ `arch` and a matching `delta-patch` asset exists for `current → latest`, add:

```jsonc
"patch": {
  "from_version_code": 1020100,
  "algorithm": "archive-patcher-v1",
  "download_url": "<signed R2 url>",
  "size_bytes": 3145728,
  "target_sha256": "<sha256 of the reconstructed APK>"
}
```

Client picks `patch` when present and it can locate its installed base APK;
otherwise it uses the full `download_url`. No server-side behavior change for
old SDKs (they ignore the new field).

### 3. Android SDK (apply)
`UpdateChecker`, when the response carries `patch`:
1. Locate the installed base APK: `context.applicationInfo.sourceDir` (the
   currently-running APK — this *is* the `from_version_code` artifact).
2. Download the patch (signed URL) to app storage.
3. `FileByFileV1DeltaApplier().applyDelta(oldApk, patchStream, newApkOut)`.
4. **Verify** the reconstructed APK: sha256 == `target_sha256` **and** its
   signing certificate matches the running app's (reject on mismatch — a delta
   must never install a differently-signed APK). PackageManager also rejects a
   signature change on update, but we verify before handing it off.
5. Install via the existing `ApkInstaller` path.
6. **Fallback**: any failure (patch download, apply, hash/sig mismatch, base
   APK unreadable) → fall back to the full `download_url`. Delta is an
   optimization, never a hard dependency.

## Security

- Patch served over a signed, expiring R2 URL (same as full APK today).
- The reconstructed APK is verified by **sha256 against the server's recorded
  target hash** (integrity) **and signer-cert equality** (authenticity) before
  install. A corrupted/tampered patch can only produce a hash mismatch → full
  fallback, never a bad install.
- Splits by `arch` so a patch is only offered for the client's own ABI.

## Bandwidth expectation (set honestly)
Savings are version-pair-dependent. Releases that only touch Kotlin/resources
compress to a small delta (often 10–30% of full). Releases that change native
`.so` (NetworkKMM bumps, Kuikly) produce large deltas — sometimes not worth it.
So the update-check should offer the patch **only when `patch.size_bytes` is
meaningfully smaller than the full APK** (e.g. ≤ 70%); otherwise omit it and
let the client take the full download. This keeps delta a strict win.

## Phasing
- **P1 — server + generation**: archive-patcher generator in CI (patch matrix,
  N=3), `delta-patch` asset kind + metadata, `/updates/check` patch offer with
  the size-threshold guard. No client change yet (old SDKs ignore it).
- **P2 — SDK apply**: archive-patcher applier + verify + fallback in
  `UpdateChecker`; new SDK version.
- **P3 — metrics**: delta hit-rate and bytes-saved into the analytics/metrics
  ping so we can see the real win and tune N + the size threshold.

## Open questions for @artin / #245 owner
1. N (how many previous versions to keep patches for) — 3 is a sane default.
2. Do the client-side #245 wins (ABI filter) land first? They shrink the full
   APK, which also shrinks deltas — worth sequencing before measuring P3.
3. archive-patcher is Apache-2.0 and unmaintained upstream but stable and
   Play-proven; acceptable as a vendored dependency.
