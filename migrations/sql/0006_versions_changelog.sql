-- Migration 0006: add changelog column to versions.
--
-- Phase 1 admin UI surfaces a changelog textarea in the UploadDialog
-- (commit b016ab5). We need somewhere to store the user-supplied
-- release notes so Publishing dashboard + client SDK can show them.
--
-- Additive only: nullable TEXT, default NULL. Existing rows unchanged.
-- Phase 2 will migrate these notes onto the new `builds` table when
-- the build/release split is implemented.

ALTER TABLE versions ADD COLUMN changelog TEXT;