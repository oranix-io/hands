-- Migration 0009: release_types table
-- User-defined per app: how to label releases (stable, rc, beta, internal, nightly, ...)
-- See docs/publish-architecture.md v3 §3.4.

CREATE TABLE IF NOT EXISTS release_types (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  color           TEXT,
  description     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (app_id, name)
);

CREATE INDEX IF NOT EXISTS idx_release_types_app
  ON release_types(app_id, name);