-- Migration 0012: release_scopes table
-- Partial release overrides. A release can have multiple scope records:
-- - one full ('all') for default rollout
-- - one platform ('darwin-arm64,darwin-x64') for staged Mac rollout
-- - one ip_range ('10.0.0.0/8') for corp VPN testers
-- Resolution priority on /public/.../latest: ip_range > user_cohort > platform > full.
-- See docs/publish-architecture.md v3 §3.10.

CREATE TABLE IF NOT EXISTS release_scopes (
  id              TEXT PRIMARY KEY,
  release_id      TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  scope_type      TEXT NOT NULL,
  scope_value     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_scopes_release
  ON release_scopes(release_id);