# Quiver Publish Architecture — Android (now) + Electron / OTA (later)

Status: **draft v2, rewritten after @artin's feedback** (task #5, @Pi-Worker2)
Author: @Pi-Worker2, 2026-06-28
Scope: long-lived schema and admin UX for `versions`, `version_assets`, `product_types`. Implementation not started.

---

## 1. Goals

Quiver is an open-source APK distribution platform. The user wants to expand it to handle:

| What we're shipping | Today | Sample format |
|---|---|---|
| Android APK | ✅ shipped (current `versions` table) | `app-release.apk` |
| Android AAB | ❌ planned | `app-release.aab` |
| iOS IPA | ❌ planned (Zealot parity) | `MyApp.ipa` |
| Electron desktop app | ❌ planned (ToDesktop reference) | `MyApp-1.2.3-x64.dmg`, `.exe`, `.AppImage` |
| RN / Expo OTA JS bundle | ❌ planned (hot-updater reference) | `bundle.zip` |
| Future: CLI tool, browser extension, anything else | ❌ | user-defined |

**Core UX ask** (verbatim from @artin): "创建产品，然后选支持的平台，就像 sentry 那样" — model the admin flow after Sentry's project creation wizard: pick a product type, pick the platforms it supports, publish versions against it.

This doc designs one unified model that fits all the above. Two semantic layers separate cleanly:

- **`product_type`** = "what we're shipping" — per-app, user-defined (e.g., `android-apk`, `electron-installer`, `rn-bundle`). Analogous to Sentry's platform picker on project create.
- **`platform` + `arch`** = "OS × CPU matrix this binary runs on" — per-asset (e.g., `darwin-arm64`, `linux-x64`, `win32-x64`). For Android, `arch` is captured as `native_codes` (a list inside the APK).

## 2. Reference survey

### 2.1 Sentry (project + platform picker, the UX inspiration)

URL: https://docs.sentry.io/product/sentry-basics/integrate-frontend/create-new-project/

**UX pattern**: When you create a project, Sentry asks "What kind of project is this?" (a long list: React, Vue, Next.js, Python, iOS, Android, Electron, React Native, ...). Each project gets exactly one platform. You then wire the SDK to it. Errors come in tagged with that platform.

This is "**one product = one platform**" — simple but doesn't fit our multi-platform case (a single Electron app ships for darwin + linux + win simultaneously).

**What we steal**: the **platform picker at product creation** UX pattern. What we don't: the 1:1 product:platform constraint.

### 2.2 Zealot (full binary distribution: apk / ipa / exe / dmg)

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

- **App = grouping** (e.g. "MyApp"). Apps can be **archived** (soft delete; archived apps block upload but allow view).
- **Channel = deployment lane**. One app → N channels (production, beta, internal-test). Each channel has `device_type` (one of the platform enum), `bundle_id` (defaults to `*` = wildcard), optional `password`.
- **Release = one uploaded binary**, always tied to a channel. `release_version` (semver string) + `build_version` (monotonic int, scoped per channel via UNIQUE(channel_id, version)). **No `enabled` flag on releases** — the **latest release** on a channel is implicitly the active one.
- **Enable/disable**: not a per-release flag. Two mechanisms:
  - **Archive app** (soft-delete the whole app)
  - **Delete release** (irreversible, but only deletes that one release row)

**What we steal**: app+channel+release structure, archive app pattern. What we change: per-release `enabled` (so we can disable a specific version), `platform` becomes per-asset (not per-channel), `device_type` removed (superseded by version_assets.platform).

### 2.3 bytemain/hot-updater (RN / Expo / Electron OTA JS bundle distribution)

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
- **Channel model identical to Zealot**: e.g. `production`, `staging`, `internal`.

**What we steal**: `enabled`, `should_force_update`, `rollout_cohort_count`, `target_app_version` (for OTA only). What we change: `bundle` → our `version` (rename for consistency across product types).

### 2.4 ArekSredzki/electron-release-server (Squirrel-compatible Electron update server)

URL: https://github.com/ArekSredzki/electron-release-server — Sails.js + Postgres. **This is the closest match to our model.**

**Data model** (excerpted):

```
flavor      PRIMARY KEY name    -- e.g. 'default', 'lite', 'pro' (USER-DEFINED, not enum)
channel     PRIMARY KEY name    -- e.g. 'stable', 'dev', 'nightly' (USER-DEFINED, not enum)
version     id (name + '_' + flavor), name, channel_id, flavor_id,
            notes, availability (timestamp)
asset       id, name, platform, filetype, hash, size, download_count
            platform ENUM: linux_32, linux_64, osx_64, osx_arm64,
                         windows_32, windows_64
            filetype: 'exe' | 'dmg' | 'deb' | ...
            version_id FK
```

**Key UX patterns**:

- **`flavor`** and **`channel`** are both **user-defined lookup tables** with just a `name PRIMARY KEY`. Apps (or orgs) define their own flavors and channels — no enum.
- **Version = (name × flavor)** — same `version_name` can ship as multiple flavors (e.g. "1.2.3 default" and "1.2.3 lite"). PK is composite.
- **Asset belongs to Version** — one Version has N Assets, one per `platform`. Platform is a fixed enum (OS × arch).
- **Availability timestamp** — version can be released in the future, server gates download.

**What we steal (the most)**: the **Flavor / Channel / Version / Asset four-way split** with user-defined flavors & channels, plus Asset-level platform matrix. We rename: `flavor` → `release_type` (per @artin's vocabulary).

### 2.5 ToDesktop (managed Electron build + release service)

URL: https://www.todesktop.com/electron/docs/

**Release model**:

- **App** (product) → configured once (icon, appPath, signing certs).
- **Build** = one compilation of the Electron app (CI build, all platforms). Builds are **immutable**.
- **Release** = promote a build to be the "live" version that users auto-update to. Three release scopes (the modern staged-rollout shape):
  - **IP address release** — release to specific IP addresses only (rollout by IP range).
  - **Platform release** — release to a specific platform (e.g. only macOS users get this version; Windows stays on previous).
  - **Full release** — release to everyone, overriding any partial releases currently in effect.
- **Smoke testing** before release: ToDesktop actually launches the build on Win/Mac/Linux, captures screenshots + perf metrics + auto-update-from-previous-version tests.

**API model** (excerpted from `/v1/releaseBuild`):

```
POST /v1/releaseBuild
{ email, appId, buildId, shouldSkipEmail }
→ 200 { message: "success" }
→ 412 if build is not in a releasable state
```

Releases are **promotions of builds**, not direct uploads. The release lifecycle is: `upload build → validate → smoke test → release (scoped) → live`.

**What we steal**: the **scoped release** semantics (full / platform-scoped / IP-scoped). What we change: we don't separate Build and Release tables — Quiver combines them (a release IS a version row, with optional `rollout_*` fields).

### 2.6 Cursor (download URL matrix for IDE distribution)

URL: https://cursor.com/download + https://cursor.com/install

Cursor's public download URL matrix (from the install script):

```
darwin-arm64, darwin-universal, darwin-x64
linux, linux-arm64, linux-arm64-deb, linux-arm64-rpm,
linux-x64, linux-x64-deb, linux-x64-rpm
win32-arm64, win32-arm64-user, win32-x64, win32-x64-user
windows
```

**Pattern**: `platform-arch[-variant]` naming. The `-user` suffix is for "user-mode installer" (no admin required). The `-deb`/`-rpm` are package-format variants.

**What we steal**: the platform-arch-variant naming convention for our `version_assets.platform` enum / list.

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

**Gaps vs unified model**:
- No `product_types` table; `apps.platform` is a single hardcoded value (`'android'`)
- No `release_types` table; release "type" is implicit (stable / beta inferred from channel slug)
- No per-asset rows; APK is one monolithic `versions` row with a single `r2_key`
- No changelog, provenance, should_force_update, rollout_cohort_count
- No per-version enabled semantic (default 1 but no toggle UI)
- No apps.archived

## 4. Proposed unified model

### 4.1 product_types — what we ship

```
product_types
  id              TEXT PRIMARY KEY            -- uuid
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  name            TEXT NOT NULL               -- e.g. 'android-apk', 'electron-installer', 'rn-bundle'
  display_name    TEXT NOT NULL               -- 'Android APK', 'Electron Installer', ...
  description     TEXT
  icon            TEXT                        -- r2_key to product icon (used in admin + client SDK)
  -- platform matrix this product supports (shown in wizard, e.g. Electron = darwin+linux+win)
  supported_platforms_json TEXT NOT NULL DEFAULT '[]'
    -- e.g. ["darwin-arm64","darwin-x64","linux-x64","linux-arm64","win32-x64","win32-arm64"]
  -- parsing / packaging metadata
  parser_kind     TEXT NOT NULL DEFAULT 'unknown'
    -- 'apk-aapt' | 'electron-asar' | 'rn-bundle' | 'ipa-info' | 'unknown'
  -- which schema validation this product requires
  schema_json     TEXT NOT NULL DEFAULT '{}'
    -- e.g. { "requires_native_codes": true, "requires_electron_version": true, ... }
  created_at      INTEGER NOT NULL
  updated_at      INTEGER NOT NULL
  UNIQUE (app_id, name)
```

Each app **creates its own product types** at first save (UI: "Create App → wizard asks 'what do you want to ship?'"). Common defaults:

| `name` | `display_name` | `parser_kind` | `supported_platforms` |
|---|---|---|---|
| `android-apk` | Android APK | `apk-aapt` | (N/A — APK is platform-agnostic; arch is native codes inside) |
| `android-aab` | Android AAB | `aapt` | (N/A) |
| `ios-ipa` | iOS IPA | `ipa-info` | (N/A) |
| `electron-installer` | Electron desktop app | `electron-asar` | `["darwin-arm64","darwin-x64","linux-x64","linux-arm64","win32-x64","win32-arm64"]` |
| `rn-bundle` | RN/Expo OTA bundle | `rn-bundle` | (N/A) |
| `cli-binary` | CLI tool | (varies) | `["darwin-arm64","darwin-x64","linux-x64","win32-x64"]` |

### 4.2 release_types — user-defined release treatment

```
release_types
  id              TEXT PRIMARY KEY
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  name            TEXT NOT NULL               -- e.g. 'stable', 'beta', 'internal', 'nightly'
  display_name    TEXT NOT NULL
  color           TEXT                        -- hex color for UI badges, e.g. '#10b981'
  description     TEXT
  created_at      INTEGER NOT NULL
  UNIQUE (app_id, name)
```

When creating an app, the wizard seeds sensible defaults:

```
DEFAULT_RELEASE_TYPES = [
  { name: 'stable',   display_name: 'Stable',   color: '#10b981', description: 'Production-ready' },
  { name: 'rc',       display_name: 'RC',       color: '#3b82f6', description: 'Release candidate' },
  { name: 'beta',     display_name: 'Beta',     color: '#f59e0b', description: 'Public beta' },
  { name: 'internal', display_name: 'Internal', color: '#6b7280', description: 'Internal team only' },
]
```

User can add/remove after creation. Examples of non-default: `nightly` (always built from `main`), `experimental` (preview features), `lts` (long-term support), `canary`, etc.

### 4.3 versions — the core release row

```
versions
  id                          TEXT PRIMARY KEY
  app_id                      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  channel                     TEXT NOT NULL          -- 'production' | 'beta' | ... (per-app channel list)
  product_type                TEXT NOT NULL          -- FK to product_types.name (composite FK)
  release_type                TEXT NOT NULL          -- FK to release_types.name (composite FK)
  version_name                TEXT NOT NULL          -- semver-like "1.2.3"
  version_code                INTEGER NOT NULL       -- monotonic int per (app, product_type, channel, release_type)
  changelog                   TEXT                   -- markdown, user-facing release notes
  enabled                     INTEGER NOT NULL DEFAULT 1
  should_force_update         INTEGER NOT NULL DEFAULT 0   -- applies to electron + bundle; ignored for apk
  rollout_cohort_count        INTEGER                  -- null=100%, else staged % (per hot-updater)
  rollout_target_cohorts_json TEXT NOT NULL DEFAULT '[]' -- explicit cohort list (overrides % when non-empty)
  availability_at             INTEGER                  -- null=now; future timestamp = scheduled publish
  icon_r2_key                 TEXT                     -- per-version icon (Zealot parity)
  provenance_json             TEXT NOT NULL DEFAULT '{}'  -- git_commit, ci_url, branch, source, ...
  metadata_json               TEXT NOT NULL DEFAULT '{}'  -- product-type-specific (parsed manifest fields)
  created_at                  INTEGER NOT NULL
  updated_at                  INTEGER NOT NULL
  UNIQUE (app_id, product_type, channel, release_type, version_code)
  INDEX (app_id, product_type, channel, release_type, version_code DESC)
  INDEX (enabled, app_id, channel, product_type)
  INDEX (availability_at) WHERE availability_at IS NOT NULL
```

**Composite FKs**: `product_type` FK → `product_types(app_id, name)`; `release_type` FK → `release_types(app_id, name)`. Both scoped to the same `app_id` row.

### 4.4 version_assets — per-platform binaries

A single Version has **N Assets**, one per `(platform, arch)` matrix entry supported by the product.

```
version_assets
  id                  TEXT PRIMARY KEY
  version_id          TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE
  platform            TEXT NOT NULL    -- e.g. 'darwin-arm64', 'linux-x64', 'win32-x64'
  arch                TEXT             -- e.g. 'arm64', 'x64', 'x86', 'universal' (or NULL for non-arch)
  variant             TEXT             -- e.g. 'user' (no-admin installer), 'deb', 'rpm', 'appimage' (or NULL)
  filetype            TEXT NOT NULL    -- 'apk' | 'exe' | 'dmg' | 'deb' | 'rpm' | 'appimage' | 'zip' | ...
  r2_key              TEXT NOT NULL
  file_hash           TEXT NOT NULL    -- sha256
  size_bytes          INTEGER NOT NULL
  signature           TEXT             -- for apk: apk-signer v1/v2/v3 hex; for electron: codesign hash; null for others
  metadata_json       TEXT NOT NULL DEFAULT '{}'  -- product-type-specific (e.g. apk native_codes list)
  download_count      INTEGER NOT NULL DEFAULT 0
  created_at          INTEGER NOT NULL
  UNIQUE (version_id, platform, arch, variant)
  INDEX (version_id)
```

**Why per-asset instead of per-version**: matches Electron / ToDesktop reality where one Version (e.g. 1.2.3) ships for **multiple platforms simultaneously**. A single row couldn't represent all the binaries.

### 4.5 channels — stays close to current, no device_type

```
channels
  id              TEXT PRIMARY KEY
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
  slug            TEXT NOT NULL
  name            TEXT NOT NULL
  password        TEXT                          -- optional gate (Zealot parity)
  git_url         TEXT                          -- link to repo/branch this channel tracks
  created_at      INTEGER NOT NULL
  UNIQUE (app_id, slug)
```

**Removed**: `device_type` (was a per-channel attribute). Channels now serve **all** product_types/platforms that the app supports. Client specifies `?product_type=electron-installer&platform=darwin-arm64` to disambiguate.

### 4.6 apps — adds archived + scheme

```
apps
  id            TEXT PRIMARY KEY
  slug          TEXT NOT NULL UNIQUE
  name          TEXT NOT NULL
  description   TEXT
  scheme        TEXT                    -- optional sub-track (Zealot parity, future use)
  archived      INTEGER NOT NULL DEFAULT 0
  archived_at   INTEGER
  created_at    INTEGER NOT NULL
  updated_at    INTEGER NOT NULL
```

**Archived apps** (Zealot parity):
- Block new version uploads (`409 Conflict`)
- Hide from AppsList by default (admin can toggle "show archived")
- Allow view + delete + unarchive

### 4.7 Public client API

Three endpoints, all no-auth, return latest *enabled* version on the channel for the requested product_type.

```
GET /public/apps/:slug/latest?channel=production&product_type=android-apk
GET /public/apps/:slug/latest?channel=production&product_type=electron-installer&platform=darwin-arm64
GET /public/apps/:slug/channels
GET /public/apps/:slug/versions?channel=production&product_type=android-apk&limit=10
```

For OTA bundles (`product_type=rn-bundle`), the response shape is different — return **all** enabled bundles matching the client's `target_app_version`, not just latest. The client picks.

```
GET /public/apps/:slug/bundles?channel=production&product_type=rn-bundle&app_version=1.2.3
→ 200 [{ version_name, file_hash, should_force_update, metadata, ... }]
```

For per-platform electron assets, the latest-version response includes all per-platform download URLs:

```json
{
  "version": "1.2.3",
  "version_code": 42,
  "release_type": "stable",
  "changelog": "...",
  "assets": [
    { "platform": "darwin-arm64", "download_url": "/api/r2/...", "size_bytes": 89123456, "signature": "..." },
    { "platform": "linux-x64",   "download_url": "/api/r2/...", "size_bytes": 76543210 },
    { "platform": "win32-x64",    "download_url": "/api/r2/...", "size_bytes": 82345678 }
  ]
}
```

## 5. Admin UX — publish flow redesign

### 5.1 Sentry-style: App creation wizard (new step)

Currently: `+ New App` → modal asks name + slug → save.

**New**: `+ New App` → **3-step wizard**:

```
Step 1: Basics
  - Name (text)
  - Slug (text, kebab-case, auto-generated from name)
  - Description (textarea)

Step 2: Product types — "What do you want to ship?" (CHECKBOX LIST)
  - [x] Android APK                (parser: apk-aapt)
  - [ ] Android AAB                (parser: aapt)
  - [ ] iOS IPA                    (parser: ipa-info)
  - [x] Electron desktop app       (parser: electron-asar)
        ↳ If checked, show sub-picker for supported platforms:
            [x] macOS (darwin-arm64, darwin-x64)
            [x] Linux (linux-x64, linux-arm64)
            [x] Windows (win32-x64, win32-arm64)
  - [ ] React Native OTA bundle    (parser: rn-bundle)
  - [ ] CLI tool                   (parser: unknown)
  - [ + Add custom product type ]
  
Step 3: Release types — "How do you label releases?" (review + customize seeded defaults)
  - [x] stable   (green badge)
  - [x] rc       (blue badge)
  - [x] beta     (orange badge)
  - [x] internal (gray badge)
  - [ + Add custom release type ]
```

On Save, the wizard:
1. Creates `apps` row
2. For each checked product_type → `product_types` row (with `supported_platforms_json` if applicable)
3. Seeds `release_types` with defaults (or user's customized list)

### 5.2 UploadWizard — channel-first 5-step

```
Step 0: Header "Publish a new version of <AppName>"

Step 1: Target (channel-first)
  - Channel dropdown (production / beta / ...) [required]
  - Product type dropdown (filtered to what app supports) [required]
  - Release type dropdown (from app's release_types) [required]
  - Show context: latest version on (channel, product_type, release_type)

Step 2: Files (per-platform matrix)
  - If product_type == 'android-apk':
      Single file picker (.apk), parsed via aapt → metadata shown
  - If product_type == 'electron-installer':
      Per-platform file picker:
        [ macOS  ]  ⌘ + click to add multiple  ───  [ .dmg | .zip ]
          ↳ darwin-arm64  ──── [drag .dmg here]
          ↳ darwin-x64    ──── [drag .dmg here]
        [ Linux  ]
          ↳ linux-x64     ──── [drag .AppImage here]
        [ Windows]
          ↳ win32-x64     ──── [drag .exe here]
  - If product_type == 'rn-bundle':
      Single .zip picker, manifest parsed (target_app_version, fingerprint_hash)

Step 3: Release details
  - version_name (text, auto-filled from parsed metadata, editable)
  - version_code (number, auto-incremented from latest on this lane, editable)
  - changelog (markdown textarea)
  - should_force_update (checkbox, default off)
  - rollout_cohort_count (slider 0-100, default 100; only enabled for electron + bundle)
  - rollout_target_cohorts_json (advanced — explicit cohort list)
  - availability_at (datetime picker; default = now; can schedule future)
  - provenance (auto-filled from CI if available; editable)

Step 4: Review + publish
  - Summary card of all choices + per-asset preview
  - "Publish" button
  - Backend: parse each asset → upload to R2 → insert version + version_assets rows → return 201
```

### 5.3 Publishing dashboard — new columns visible

Zealot-style "Publishing" page per app:

| Version | Release Type | Changelog | Size | Status | Assets | Actions |
|---|---|---|---|---|---|---|
| 1.2.3 (1042) | stable | "Fixed login bug" | 23 MB | ✅ enabled | apk | Move · Disable · Bump rollout · Force update · Delete |
| 1.2.2 (1041) | stable | ... | 23 MB | ⚪ disabled | apk | Move · Enable · Delete |
| 1.3.0-beta (1050) | beta | ... | 24 MB | 🚦 30% rollout | apk | Bump rollout · Disable · Delete |
| 1.4.0-rc (1060) | rc | "New Electron build" | 178 MB | ✅ enabled | 6 platforms | Promote to stable · Disable · Delete |

**Per-row actions**:
- **Move to channel** — change `(channel, release_type)` of a version
- **Disable / Enable** — toggle `versions.enabled`
- **Bump rollout** — increment `rollout_cohort_count` for staged rollouts (10% → 25% → 50% → 100%)
- **Force update** — flip `should_force_update` (one-click critical fix)
- **Promote** — copy version with new `release_type` (e.g. rc → stable, promoting a tested build)
- **Delete** — hard delete (irreversible; audit log captures the deletion event)
- **Asset matrix view** — click row → shows per-platform download URLs, smoke test results (future)

### 5.4 Channels page — per-app CRUD

Currently `AppDetail` has a "Channels" tab. New:
- Show channels with: name, slug, password (locked/unlocked icon), git_url
- `+ New channel` modal: name + slug + optional password + git_url
- Per channel: list of (product_type, latest version, latest version's status badge)

### 5.5 AppsList — show archived

- Toggle "Show archived" pill
- Archived apps: grayed out, click to view + unarchive + delete

## 6. Schema migration plan

**Phase 1 (Android only, additive)** — ship independently:
- Migration 0004: add `apps.archived`, `apps.archived_at`, `apps.scheme`, `apps.description`. Add `channels.password`, `channels.git_url`. Add `versions.changelog`, `versions.provenance_json`, `versions.should_force_update`, `versions.rollout_cohort_count`, `versions.rollout_target_cohorts_json`, `versions.availability_at`, `versions.icon_r2_key`, `versions.metadata_json`, `versions.enabled` (already present but unused). **All new columns nullable or default 0.**
- No admin UI changes yet — but everything starts populating.
- ~1 hour.

**Phase 2 (multi-platform, new tables)** — ship independently:
- Migration 0005: create `product_types` + `release_types` tables. Backfill `release_types` with `stable/rc/beta/internal` defaults for every existing app. Backfill `product_types` with one `'android-apk'` per existing app.
- Migration 0006: create `version_assets` table. Backfill: for each existing `versions` row, create one `version_assets` row with `platform='android'`, `arch=NULL`, `variant=NULL`, `r2_key=versions.r2_key`, `file_hash=versions.file_hash`, etc.
- Migration 0007: add `versions.product_type`, `versions.release_type` columns with composite FKs. Backfill with the only existing value (`android-apk` / `stable`). Change UNIQUE constraint to `(app_id, product_type, channel, release_type, version_code)`.
- Admin UI: App wizard (Step 1.1) + UploadDialog 5-step (Steps 1-3-4) + Publishing dashboard with new actions. ~6 hours total.

**Phase 3 (OTA bundles + per-platform Electron)** — ship independently:
- Migration 0008: add `version_assets.target_app_version` (extract from metadata_json to top-level for queryability), `version_assets.fingerprint_hash`.
- Container parser: add `electron-asar` and `rn-bundle` parsers alongside the existing `apk-aapt` parser.
- Public API: add `/public/apps/:slug/bundles` endpoint.
- Client SDK: add per-platform download URL parsing + bundle matching.
- ~1-2 weeks.

Each phase is shippable independently. Admin UI ships per phase.

## 7. Open questions

1. **`flavor` vs `release_type`** — `@artin` said "release_type" but electron-release-server uses "flavor". Sticking with `release_type` per user. OK?

2. **Hard-delete vs soft-delete versions** — recommendation: hard-delete only (audit log preserves forensic trail). Zealot does the same.

3. **Scheduled publish** (`availability_at`) — worth the complexity? hot-updater has it; Zealot doesn't. Recommendation: ship Phase 1 with the column, expose UI in Phase 3.

4. **Staged rollouts for full APK** — does it make sense? APK updates aren't reversible mid-download, so 10% rollout means 10% of users can't update yet → confusing. Recommendation: rollout_cohort_count works for `rn-bundle` + `electron-installer` only; ignore for `android-apk` and `android-aab`. Document clearly.

5. **Per-platform channel filtering** — `channels` no longer has `device_type`. Client passes `product_type` + `platform` query params; server filters versions. Edge case: client passes `platform=darwin-arm64` but the app's `electron-installer` product_type doesn't include `darwin-arm64` in its `supported_platforms_json` → return 404 with clear message.

6. **Per-version icon** — useful for visual ID in download pages. Zealot stores it. Recommendation: store as R2 key in `versions.icon_r2_key`, expose admin UI upload step in Phase 2 admin work.

7. **Smoke tests** (ToDesktop's biggest differentiator) — they actually launch builds on Win/Mac/Linux before release. Out of scope for v1, but worth noting as a future feature. Would need Cloudflare Container with desktop OS images (or integration with external CI).

8. **How does the admin UI pre-populate `product_types` for the App wizard?** Defaults per "app category" — should we let the user pick a category (mobile app / desktop app / web service) and seed relevant defaults? Or just always show the full checklist and let them check what they want? Recommend the latter for v1 (simpler), add category-based recommendations later.

## 8. Implementation order (post-approval)

1. Phase 1 schema migration. Deploy. No admin UI changes. ~1 hour.
2. Phase 1 admin UI (use existing fields, add archive toggle on AppsList, add changelog textarea to UploadDialog step 3). Deploy. ~3 hours.
3. Phase 2 schema migrations (5-7). Deploy. ~2 hours.
4. App creation wizard (3 steps). Deploy. ~3 hours.
5. UploadDialog 5-step wizard. Deploy. ~4 hours.
6. Publishing dashboard with new columns + actions. Deploy. ~4 hours.
7. Phase 3 schema + container parsers + bundles endpoint + client SDK. ~1-2 weeks.

Each step is independently shippable.

## 9. References

- Sentry: https://docs.sentry.io/product/sentry-basics/integrate-frontend/create-new-project/
- Zealot: https://zealot.ews.im/docs/ + https://github.com/tryzealot/zealot
- bytemain/hot-updater: https://github.com/bytemain/hot-updater (fork at oranix-io/quiver Insurance note in MEMORY)
- ArekSredzki/electron-release-server: https://github.com/ArekSredzki/electron-release-server
- ToDesktop: https://www.todesktop.com/electron/docs/
- Cursor: https://cursor.com/download + https://cursor.com/install
- Quiver current schema: `migrations/sql/0001_init.sql`, `0002_operation_logs.sql`, `0003_operation_logs_nullable_app.sql`
- Admin UI: `admin/src/pages/AppDetail.tsx` (UploadDialog + Publishing dashboard)