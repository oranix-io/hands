-- Migration 0015: builds table gets publish control fields.
--
-- The builds table (introduced in 0005) needs provenance + force-update
-- fields so future build creation flows (post-Phase 2 UI) can populate them,
-- and so releases can denormalize these for fast latest-version queries.
--
-- Additive: nullable or default 0.

ALTER TABLE builds ADD COLUMN should_force_update INTEGER NOT NULL DEFAULT 0;
ALTER TABLE builds ADD COLUMN availability_at INTEGER;
ALTER TABLE builds ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_builds_availability
  ON builds(availability_at) WHERE availability_at IS NOT NULL;