-- Migration 0011: releases table
-- A release = promote a build to "live" with scope. Mutable.
-- One build can be re-released multiple times with different scopes.
-- See docs/publish-architecture.md v3 §3.9.

CREATE TABLE IF NOT EXISTS releases (
  id                          TEXT PRIMARY KEY,
  app_id                      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id                    TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  channel_id                  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  product_type                TEXT NOT NULL,
  release_type                TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  is_full                     INTEGER NOT NULL DEFAULT 1,
  superseded_by_release_id    TEXT REFERENCES releases(id) ON DELETE SET NULL,
  rollout_cohort_count        INTEGER,
  rollout_target_cohorts_json TEXT NOT NULL DEFAULT '[]',
  availability_at             INTEGER,
  should_force_update         INTEGER NOT NULL DEFAULT 0,
  changelog                   TEXT,
  provenance_json             TEXT NOT NULL DEFAULT '{}',
  created_by                  TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_releases_app_channel_status
  ON releases(app_id, channel_id, product_type, release_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_releases_build
  ON releases(build_id);

CREATE INDEX IF NOT EXISTS idx_releases_status
  ON releases(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_releases_superseded_by
  ON releases(superseded_by_release_id) WHERE superseded_by_release_id IS NOT NULL;