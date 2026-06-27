-- Migration 0005: publish architecture Phase 1 (additive, non-breaking).
--
-- Goal: introduce the columns + scaffolding tables from docs/publish-architecture.md
-- v3 Phase 1, WITHOUT removing or breaking the existing versions table.
--
-- Additive columns on existing tables:
--   apps.archived, apps.archived_at, apps.description
--   channels.password, channels.git_url, channels.bundle_id,
--   channels.enabled_product_types_json, channels.metadata_json
--
-- New scaffolding tables (no usage yet, just for column presence + future
-- backfill from versions in Phase 2):
--   builds
--   signing_credentials
--
-- Future migrations (0006+) will:
--   - Create product_types, release_types, build_assets, releases, release_scopes
--   - Backfill builds from versions
--   - Migrate versions reads to read from builds/releases

-- ---------- apps: archived + description ----------

ALTER TABLE apps ADD COLUMN description TEXT;
ALTER TABLE apps ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN archived_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_apps_archived
  ON apps(archived, created_at DESC);

-- ---------- channels: bundle_id + password + git_url + enabled_product_types ----------

ALTER TABLE channels ADD COLUMN bundle_id TEXT;
ALTER TABLE channels ADD COLUMN password TEXT;
ALTER TABLE channels ADD COLUMN git_url TEXT;
ALTER TABLE channels ADD COLUMN enabled_product_types_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE channels ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

-- ---------- builds: scaffolding (no usage yet) ----------
--
-- Mirrors the docs/publish-architecture.md v3 §3.7 schema. Nullable FK to
-- channels (so the table can be created before backfill). status uses TEXT
-- (not CHECK constraint) so future status values can be added without
-- a schema migration.

CREATE TABLE IF NOT EXISTS builds (
  id                      TEXT PRIMARY KEY,
  app_id                  TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  channel_id              TEXT REFERENCES channels(id) ON DELETE SET NULL,
  product_type            TEXT NOT NULL DEFAULT 'android-apk',
  release_type            TEXT NOT NULL DEFAULT 'stable',
  version_name            TEXT NOT NULL,
  version_code            INTEGER NOT NULL,
  changelog               TEXT,
  source                  TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'cli' | 'ci'
  status                  TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'building' | 'succeeded' | 'failed' | 'smoke_testing' | 'smoke_test_passed' | 'smoke_test_failed'
  build_metadata_json     TEXT NOT NULL DEFAULT '{}',
  parsed_metadata_json    TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  completed_at            INTEGER
);

-- Note: no UNIQUE constraint yet because Phase 2 may want to backfill from
-- versions which already has UNIQUE(app_id, channel, version_code). Phase 2
-- migration will re-evaluate the constraint with the wider scope
-- (app_id, product_type, channel_id, release_type, version_code).
CREATE INDEX IF NOT EXISTS idx_builds_app_channel_created
  ON builds(app_id, channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_builds_status_created
  ON builds(status, created_at DESC);

-- ---------- signing_credentials: account-level code signing cert storage ----------
--
-- Stores Mac Developer ID / HSM EV / Azure Artifact Signing / APK v1/v2/v3
-- certificates. encrypted_blob holds the .p12 (or equivalent) encrypted
-- with AES-256-GCM using a KMS-derived key. The actual encryption layer is
-- implemented in worker/src/routes/signing.ts (Phase 2 work); this
-- migration only establishes the table.

CREATE TABLE IF NOT EXISTS signing_credentials (
  id                  TEXT PRIMARY KEY,
  owner_type          TEXT NOT NULL DEFAULT 'account',  -- 'account' (future: 'org', 'team')
  owner_id            TEXT NOT NULL,                     -- account ID (or org ID)
  platform            TEXT NOT NULL,                     -- 'macos' | 'windows' | 'android' | 'ios' | ...
  kind                TEXT NOT NULL,                     -- 'developer-id-app' | 'developer-id-installer' | 'mas-dev' | 'mas-dist' | 'mas-installer' | 'hsm-ev' | 'azure-artifact-signing' | 'apk-v1-v2-v3' | ...
  label               TEXT NOT NULL,
  encrypted_blob      BLOB NOT NULL,
  metadata_json       TEXT NOT NULL DEFAULT '{}',        -- issuer_id, key_id, azure_tenant_id, azure_client_id, etc.
  expires_at          INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_signing_owner_platform
  ON signing_credentials(owner_type, owner_id, platform);
CREATE INDEX IF NOT EXISTS idx_signing_expires
  ON signing_credentials(expires_at);