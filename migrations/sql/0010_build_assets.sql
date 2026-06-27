-- Migration 0010: build_assets table
-- Per-(platform, arch, variant, filetype) binaries for each build.
-- One build has N assets: e.g., Electron 1.2.3 ships for darwin-arm64-dmg,
-- darwin-x64-dmg, linux-x64-deb, linux-x64-appimage, win32-x64-exe, ...
-- See docs/publish-architecture.md v3 §3.8.

CREATE TABLE IF NOT EXISTS build_assets (
  id                      TEXT PRIMARY KEY,
  build_id                TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  platform                TEXT NOT NULL,
  arch                    TEXT,
  variant                 TEXT,
  filetype                TEXT NOT NULL,
  r2_key                  TEXT NOT NULL,
  file_hash               TEXT NOT NULL,
  size_bytes              INTEGER NOT NULL,
  signature               TEXT,
  signing_credential_id   TEXT REFERENCES signing_credentials(id) ON DELETE SET NULL,
  metadata_json           TEXT NOT NULL DEFAULT '{}',
  download_count          INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  UNIQUE (build_id, platform, arch, variant, filetype)
);

CREATE INDEX IF NOT EXISTS idx_build_assets_build
  ON build_assets(build_id);

CREATE INDEX IF NOT EXISTS idx_build_assets_signing
  ON build_assets(signing_credential_id) WHERE signing_credential_id IS NOT NULL;