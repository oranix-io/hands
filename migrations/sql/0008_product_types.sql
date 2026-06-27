-- Migration 0008: product_types table
-- User-defined per app: what kinds of artifacts we ship
-- (android-apk, electron-installer, rn-bundle, ios-ipa, cli-binary, ...)
-- See docs/publish-architecture.md v3 §3.3.

CREATE TABLE IF NOT EXISTS product_types (
  id                          TEXT PRIMARY KEY,
  app_id                      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  display_name                TEXT NOT NULL,
  description                 TEXT,
  icon                        TEXT,
  supported_platforms_json    TEXT NOT NULL DEFAULT '[]',
  default_assets_json         TEXT NOT NULL DEFAULT '[]',
  parser_kind                 TEXT NOT NULL DEFAULT 'unknown',
  schema_json                 TEXT NOT NULL DEFAULT '{}',
  parent_product_type_id     TEXT REFERENCES product_types(id) ON DELETE SET NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  UNIQUE (app_id, name)
);

CREATE INDEX IF NOT EXISTS idx_product_types_app
  ON product_types(app_id, name);

CREATE INDEX IF NOT EXISTS idx_product_types_parent
  ON product_types(parent_product_type_id) WHERE parent_product_type_id IS NOT NULL;