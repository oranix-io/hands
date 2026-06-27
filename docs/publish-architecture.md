# Quiver Publish Architecture — Android (now) + Electron / OTA (later)

Status: **draft, awaiting review** (task #5, @Pi-Worker2)
Author: @Pi-Worker2, 2026-06-28
Scope: long-lived schema and admin UX for `versions`, `channels`, `bundles`. Implementation not started.

---

## 1. Goals

Quiver is an open-source APK distribution platform. The user wants to expand it to handle:

| Platform | Update mechanism | Today |
|---|---|---|
| Android (apk / aab) | Full APK download | ✅ shipped (current `versions` table) |
| Electron (full installer) | Download new `.exe` / `.dmg` / `.AppImage` | ❌ planned |
| React Native / Electron (OTA JS bundle) | Download JS bundle, hot-reload app | ❌ planned (inspiration: bytemain/hot-updater) |

All three share the same admin problem: **how do I publish a new version of an app, target it at specific users (channel), decide whether to push it, and roll it back?**

This doc designs one unified model that fits all three, prioritizing the **version identity** as the primary axis, with platform-specific metadata as a sidecar.

## 2. Reference survey

### Zealot (apk / ipa / macOS / Windows / Linux app distribution)

URL: https://zealot.ews.im — open-source, Rails + PostgreSQL.

**Data model** (from `db/schema.rb`):

```
apps           id, name, description, archived           ← soft-delete via "archived" flag
schemes        id, app_id, name                          ← logical "track" within an app
channels       id, scheme_id, name, slug, device_type, bundle_id='*', password, git_url, key
                enum device_type: ios | android | harmonyos | macos | windows | linux
releases       id, channel_id, name, file, icon,
                release_type, release_version (e.g. "1.2.3"),
                build_version (e.g. "1024"), branch, git_commit, ci_url,
                changelog (jsonb), custom_fields (jsonb),
                version (monotonic int, scoped to channel)
                UNIQUE (channel_id, version)
metadata       id, release_id, bundle_id, release_version, build_version,
                release_type, platform, device, size, permissions (jsonb),
                capabilities, deep_links, url_schemes, services,
                entitlements, native_codes, mobileprovision,
                activities, checksum, min_sdk_version, target_sdk_version
debug_files    id, app_id, file, device_type, build_version, release_version, checksum
```

**Key UX patterns**:

- **App = grouping** (e.g. "MyApp"). Apps can be **archived** (soft delete; archived apps block upload but allow view). Archived apps can be **deleted** outright but **only** after un-archive (Zealot #1886).
- **Scheme = intermediate grouping** (optional). E.g. "MyApp-Android" + "MyApp-iOS" under one App. Today we don't need this.
- **Channel = deployment lane**. One app → N channels (production, beta, internal-test). Each channel has `device_type`, `bundle_id` (defaults to `*` = wildcard), optional `password`.
- **Release = one uploaded binary**, always tied to a channel. `release_version` (semver string) + `build_version` (monotonic int, scoped per channel via UNIQUE(channel_id, version)). No `enabled` flag on releases — the **latest release** on a channel is implicitly the active one. Older releases are kept for history / reinstall.
- **Enable/disable**: not a per-release flag. Two mechanisms:
  - **Archive app** (soft-delete the whole app)
  - **Delete release** (irreversible, but only deletes that one release row)
- **Public client API**: `/api/apps/latest?channel_key=...&release_version=...&build_version=...&bundle_id=...&sdk=...` — returns latest version on channel that user should upgrade to. Client compares local version vs server.

### bytemain/hot-updater (React Native / Expo / Electron OTA JS bundle updates)

URL: https://github.com/bytemain/hot-updater

**Data model**:

```
bundles                id, platform, channel, file_hash, storage_uri,
                       target_app_version, fingerprint_hash,
                       should_force_update, enabled, message, metadata (json),
                       git_commit_hash, rollout_cohort_count, target_cohorts (json)
private_hot_updater_settings  key, value
```

**Key UX patterns**:

- **Bundle = one uploaded JS / asset bundle**, NOT a full binary. The native app shell stays installed; only the JS layer is replaced.
- **`enabled` boolean** per bundle — toggle to disable without deleting.
- **`should_force_update`** — if true, client must install (no "skip" option). For critical security fixes.
- **`target_app_version`** — semver range ("1.2.x", ">=1.2.0 <2.0.0") the bundle applies to. Crucial because OTA bundles are coupled to specific native versions (Hermes bytecode compatibility, native module bindings).
- **`rollout_cohort_count` + `target_cohorts`** — staged rollouts. Cohort is a deterministic hash of device-id; count is the % enabled.
- **No "latest" semantics** — server returns ALL enabled bundles matching the client's `(platform, channel, app_version)`, and the client picks the most recent.
- **Channel model identical to Zealot**: e.g. `production`, `staging`, `internal`.

## 3. Quiver today (Android only)

```
apps            id, slug, name, platform  (no archived yet)
channels        id, app_id, slug, name    (no device_type, no password)
versions        id, app_id, channel, version_name, version_code,
                package_name, signature_sha256, min_sdk, target_sdk,
                size_bytes, file_hash, r2_key, enabled, created_at
                UNIQUE (app_id, channel, version_code)
audit_logs      id, app_id, action, actor, payload, created_at
operation_logs  id, app_id (nullable), kind, status, parent_op_id, step_number,
                input, output, error, progress, retry_count,
                created_at, updated_at, completed_at
```

**Gaps vs Zealot**:
- No `apps.archived`
- No `changelog` (free-form user-facing release notes)
- No `release_type` (alpha/beta/stable)
- No `ci_url`, `git_commit`, `branch` (provenance)
- No `custom_fields` (extensibility)
- No per-channel `password` (gated download)
- No `icon` (release icon)
- No `device_type` per channel (one app == one platform; channels all same platform)
- No `metadata` sidecar (permissions / native_codes / capabilities)

**Gaps vs hot-updater**:
- No `enabled` semantic on per-release (Zealot-style: latest = active)
- No `should_force_update`
- No `target_app_version` semantic (irrelevant for full APK, but will matter for OTA bundles)
- No `rollout_cohort_count` / staged rollouts
- No `fingerprint_hash`

## 4. Proposed unified model

### 4.1 Core identity

A `version` is the unit of "ship something to users". Every release — APK, Electron installer, OTA JS bundle — is a version.

```
versions
  id                          TEXT PRIMARY KEY  -- uuid
  app_id                      TEXT NOT NULL REFERENCES apps(id)
  channel                     TEXT NOT NULL          -- 'production' | 'beta' | ...
  platform                    TEXT NOT NULL          -- 'android' | 'electron' | 'rn-bundle' | ...
  version_name                TEXT NOT NULL          -- semver-like "1.2.3"
  version_code                INTEGER NOT NULL       -- monotonic int, monotonic per (app, channel, platform)
  release_type                TEXT NOT NULL DEFAULT 'stable'  -- 'alpha' | 'beta' | 'rc' | 'stable'
  changelog                   TEXT                   -- markdown, user-facing release notes
  r2_key                      TEXT NOT NULL          -- storage path
  file_hash                   TEXT NOT NULL          -- sha256
  size_bytes                  INTEGER NOT NULL
  enabled                     INTEGER NOT NULL DEFAULT 1   -- 0=disabled, 1=enabled (matches hot-updater)
  should_force_update         INTEGER NOT NULL DEFAULT 0   -- applies to electron + bundle; ignored for apk (always required install)
  rollout_cohort_count        INTEGER                  -- null=100%, else staged %
  metadata_json               TEXT NOT NULL DEFAULT '{}'  -- platform-specific (see 4.2)
  provenance_json             TEXT NOT NULL DEFAULT '{}'  -- git_commit, ci_url, branch, source (CI / web / cli)
  created_at                  INTEGER NOT NULL
  updated_at                  INTEGER NOT NULL
  UNIQUE (app_id, channel, platform, version_code)
  INDEX (app_id, channel, platform, created_at DESC)
  INDEX (enabled, app_id, channel, platform)
```

Differences from current `versions`:
- **`platform` added** (per-version, not per-app) — one app can host Android + Electron + RN bundle versions on the same channel.
- **`release_type`** added — alpha/beta/rc/stable label.
- **`changelog`** added — free-form text, shown in admin UI + client.
- **`enabled`** is now a real flag (currently unused except default 1).
- **`should_force_update`** + **`rollout_cohort_count`** — staged rollout + critical update semantics from hot-updater.
- **`metadata_json`** + **`provenance_json`** — extensible sidecars (see 4.2).
- **`version_code` uniqueness** now scoped to `(app_id, channel, platform)` instead of `(app_id, channel)` — allows Android `versionCode=1` and Electron `versionCode=1` to coexist.

### 4.2 Platform-specific metadata (sidecar)

Stored as JSON in `metadata_json`. Three platforms today:

```jsonc
// platform = 'android' — what we already parse from APK
{
  "package_name": "com.example.myapp",
  "signature_sha256": "d7b17c41...",
  "min_sdk": 21,
  "target_sdk": 34,
  "app_label": "MyApp",
  "permissions": ["android.permission.INTERNET", ...],   // NEW — from AndroidManifest
  "native_codes": ["arm64-v8a", "armeabi-v7a", "x86_64"] // NEW — from lib/ scan
}

// platform = 'electron'
{
  "electron_version": "32.1.0",
  "asar_hash": "sha256:...",
  "platforms": ["win32-x64", "darwin-arm64", "linux-x64"],  // which installers are in this version
  "min_supported_os": { "win": "10.0.0", "macos": "11.0.0", "linux": "glibc>=2.31" },
  "auto_update_compatible": true    // can the app self-update, or does it need full re-download?
}

// platform = 'rn-bundle'
{
  "target_app_version": ">=1.2.0 <2.0.0",  // semver range (hot-updater compat)
  "fingerprint_hash": "sha256:...",         // bundle integrity
  "engine": "hermes",                       // 'hermes' | 'jsc' | 'v8'
  "assets_included": ["splash.png", ...],
  "min_runtime": "1.2.0"
}
```

Provenance is the same shape across platforms:

```jsonc
// provenance_json
{
  "git_commit": "abc1234",
  "git_branch": "main",
  "ci_url": "https://github.com/foo/bar/actions/runs/123",
  "source": "ci",     // 'web' | 'cli' | 'ci'
  "uploaded_by": "admin@oranix.io",
  "build_duration_ms": 234567,
  "builder": "github-actions",
  "trigger": "tag:v1.2.3"
}
```

### 4.3 Channels — stay close to current

Current schema is fine for Android. Additions:

```
channels
  ...
  device_type       TEXT           -- 'android' | 'electron' | 'rn-bundle' | '*' (any)
  bundle_id         TEXT DEFAULT '*'   -- wildcard '*' or specific id (e.g. com.example.myapp)
  password          TEXT           -- optional gate; if set, /public/.../latest requires ?password=
  git_url           TEXT           -- link to repo at this channel
  index (device_type)
```

Adding `device_type` to channels makes Zealot-style per-platform routing possible: an Android client asking for "production" gets routed to the channel with `device_type='android'` (or `'*'`).

**Channel uniqueness**: today `(app_id, slug)`. Should be `(app_id, slug, device_type)` — channels are scoped per platform. But that breaks admin UX (user has to create "production-android" and "production-electron"). Compromise: keep `(app_id, slug)`, but **share** a channel across platforms by allowing multiple `device_type` values. So one channel record can serve both.

Best compromise: **channel is per-app (one row per (app_id, slug))**, and `device_type` becomes a metadata tag (not a column) stored as a JSON list:

```jsonc
// channels table — add
device_types_json  TEXT NOT NULL DEFAULT '["android"]'   -- e.g. ["android","rn-bundle"]
```

A channel serves any platform listed. Client asks `GET /public/apps/:slug/latest?channel=production&platform=android`, server filters versions by `versions.platform IN (channels.device_types_json)`.

### 4.4 Apps — add archived + scheme support

```
apps
  ...
  archived          INTEGER NOT NULL DEFAULT 0   -- soft-delete flag (Zealot parity)
  archived_at       INTEGER
  scheme            TEXT                         -- optional sub-track (Zealot parity, future use)
```

Archived apps:
- Block new version uploads (`409 Conflict`)
- Hide from AppsList (admin can toggle "show archived")
- Still allow view + delete + unarchive

### 4.5 Public client API

Three endpoints, all no-auth, return latest *enabled* version on the channel for the platform.

```
GET /public/apps/:slug/latest?channel=production&platform=android
GET /public/apps/:slug/channels
GET /public/apps/:slug/versions?channel=production&limit=10
```

For OTA bundles (`platform=rn-bundle`), the response shape is different — return **all** enabled bundles matching the client's `target_app_version`, not just latest. The client picks.

```
GET /public/apps/:slug/bundles?channel=production&platform=rn-bundle&app_version=1.2.3
→ 200 [{ version_name, file_hash, should_force_update, ... }]
```

(Both can coexist; the existing latest endpoint stays for full-binary installs, the bundles endpoint is for OTA.)

## 5. Admin UX — publish flow redesign

### 5.1 Today (after our fixes)

```
UploadDialog:
  Step 1: pick .apk → parse → metadata shown
  Step 2: auto-upload to R2
  Step 3: pick channel → click "Publish to <channel>" → D1 row
```

Pain points:
- Channel selection is at the END (after upload). User can't pick channel upfront.
- No "save as draft" if upload succeeds but channel decision is delayed.
- No "schedule for later".
- No rollout cohort picker (always 100%).
- No enable/disable on versions after creation.
- No changelog input.
- No app icon upload per version.
- No way to see history of versions per channel in a structured way.

### 5.2 Proposed — Channel-first, multi-step wizard

```
UploadDialog (rewritten):
  0. Header: "Publish a new version"
  
  Step 1: Channel + Platform
    - App name (read-only)
    - Channel dropdown (production / beta / internal) — required
    - Platform dropdown (Android / Electron / RN bundle) — required
    - Show existing latest version on this channel+platform for context
  
  Step 2: File
    - File picker (.apk / .exe / .dmg / .AppImage / bundle.zip depending on platform)
    - Auto-parse metadata via container (Android) or signer (Electron)
    - Show parsed metadata (package, version_code, min_sdk, native_codes, etc.)
    - Auto-fill version_name + version_code from parsed metadata (editable)
  
  Step 3: Release details
    - release_type dropdown: alpha | beta | rc | stable
    - changelog textarea (markdown)
    - should_force_update checkbox (default off; only meaningful for Electron/bundle)
    - rollout_cohort_count slider (default 100; only meaningful if platform supports staged rollout)
    - provenance auto-filled (current git/ci if available; editable)
    - Optional: schedule for later (datetime picker)
  
  Step 4: Confirm + publish
    - Summary card of all choices
    - "Publish" button (explicit)
    - Backend: parse → upload R2 → insert version row → return 201
  
  Footer: "Or close this dialog — upload will continue in bottom-right corner"
```

### 5.3 Versions table — new columns visible

The existing `/apps/:appId/publish` page (Zealot-style "Publishing dashboard"):

| Version | Channel | Platform | Type | Changelog | Size | Status | Actions |
|---|---|---|---|---|---|---|---|
| 1.2.3 (1042) | production | android | stable | "Fixed login bug" | 23 MB | ✅ enabled | Move · Disable · Delete |
| 1.2.2 (1041) | production | android | stable | ... | 23 MB | ⚪ disabled | Move · Enable · Delete |
| 1.3.0-beta (1050) | beta | android | beta | ... | 24 MB | 🚦 30% rollout | Bump rollout · Disable · Delete |

**New actions**:
- **Move to channel** — change `(app_id, channel)` of a version (e.g. promote beta → production)
- **Disable / Enable** — toggle `versions.enabled`
- **Bump rollout** — increment `rollout_cohort_count` for staged rollouts (10% → 25% → 50% → 100%)
- **Delete** — hard delete (irreversible, audits out)
- **Force update** — flip `should_force_update` (one-click critical fix)

### 5.4 What stays the same

- Apps list, app create/archive/unarchive
- Channels CRUD (just add device_types_json column)
- Audit log + operation log + SSE
- Parse-on-upload via Cloudflare Container
- Toast on bottom-right + SSE-driven background progress

## 6. Schema migration plan

Phase 1 (Android only, non-breaking):
- Migration 0004: add `release_type`, `changelog`, `provenance_json`, `should_force_update`, `rollout_cohort_count` to `versions`. Add `enabled` index. Add `archived`, `archived_at`, `scheme` to `apps`. Add `device_types_json`, `password`, `git_url` to `channels`. **All new columns nullable or with default** — no app-side changes needed except admin UI.

Phase 2 (multi-platform, new):
- Migration 0005: add `platform` to `versions`. Backfill existing rows with `platform='android'`. Make UNIQUE constraint `(app_id, channel, platform, version_code)`. Add `metadata_json` column.

Phase 3 (OTA bundles):
- Migration 0006: add `target_app_version` (extracted from metadata_json to top-level for queryability), `fingerprint_hash`. Add `/public/apps/:slug/bundles` endpoint. Add `bundles` semantics to client SDK.

Each phase is shippable independently. Admin UI ships per phase.

## 7. Open questions

1. **Channel × platform multiplicity**: should channels be shared across platforms (one channel per `(app_id, slug)`, multiple `device_types` on the row) or per-platform (one channel per `(app_id, slug, platform)`)? Recommend the former for admin UX; semantic conflict is rare (you usually want same channel name for Android + Electron of same app).

2. **Archived versions**: do we need a soft-delete for versions? Or only hard delete? Zealot only hard-deletes. Recommendation: hard delete only (keeps schema simple), but **audit log captures the deletion event** so we have a forensic trail.

3. **Scheduled publish**: worth the complexity? hot-updater has it; Zealot doesn't. Recommendation: skip for v1, add later if requested.

4. **Rollout cohorts for full APK**: staged rollouts make sense for OTA bundles (no user pain, instant rollback) but for full APK updates, a 10% rollout means 10% of users can't update yet, which can cause confusion. Recommendation: rollout_cohort_count works for `rn-bundle` + `electron` only; ignore for `android`. Document clearly.

5. **Per-channel device filtering**: client passes `platform=android` — server returns matching versions on channel where `device_types` includes 'android'. Edge case: client passes `platform=ios` but channel only serves 'android' → return 404 with clear message.

6. **App icon per version**: useful for users to visually identify the version in a download page. Zealot stores it. Recommendation: store as R2 key in `versions.metadata_json.icon_key`, generate admin UI upload step in phase 2.

## 8. Implementation order (post-approval)

1. Migrate to phase-1 schema (additive columns + indexes). No admin UI changes yet. ~1 hour.
2. Admin UI: add `changelog` + `release_type` to UploadDialog step 3. Show `enabled` toggle in Publishing dashboard. Show `archived` flag on AppsList. ~3 hours.
3. Migrate to phase-2 schema (add `platform` column). Default existing rows to 'android'. Update UNIQUE constraint. Admin: add platform picker. ~4 hours.
4. Admin UI: rollout_cohort_count slider (only enabled for rn-bundle + electron). Move-to-channel action. Force-update toggle. ~4 hours.
5. Phase 3 (OTA bundles): implement container-based bundle parser, /public/apps/:slug/bundles endpoint, client SDK. ~1-2 weeks.

Each step is independently shippable.

## 9. References

- Zealot: https://zealot.ews.im/docs/ + https://github.com/tryzealot/zealot
- bytemain/hot-updater: https://github.com/bytemain/hot-updater (fork at oranix-io/quiver Insurance note in MEMORY)
- Quiver current schema: `migrations/sql/0001_init.sql`, `0002_operation_logs.sql`, `0003_operation_logs_nullable_app.sql`
- Admin UI: `admin/src/pages/AppDetail.tsx` (UploadDialog + Publishing dashboard)