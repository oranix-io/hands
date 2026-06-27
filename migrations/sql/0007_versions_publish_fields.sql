-- Migration 0007: add publish control fields to versions.
--
-- Phase 1 admin UI surfaces these on UploadDialog step 3:
--   should_force_update — for electron + bundle only; ignored for full APK
--   availability_at — scheduled publish (null = immediate)
--   provenance_json — git_commit / ci_url / branch / source
--
-- All additive, nullable, defaults. Existing rows unchanged.

ALTER TABLE versions ADD COLUMN should_force_update INTEGER NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN availability_at INTEGER;
ALTER TABLE versions ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_versions_availability
  ON versions(availability_at) WHERE availability_at IS NOT NULL;