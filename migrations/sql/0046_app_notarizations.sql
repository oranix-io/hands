-- Migration 0046: app_notarizations + app_notarization_attempts
-- Broker-only notarization lane (platform feature).
--
-- Two-table model (per XX control-plane terminal review, 2026-07-18):
--   app_notarizations       = logical notarization (source asset snapshot)
--   app_notarization_attempts = each Apple submission (append-only)
--
-- Key invariants enforced by this schema:
--   1. Source is an asset snapshot (r2_key/r2_etag/size/computed_sha256 frozen at submit time).
--      The computed_sha256 is derived from actual R2 bytes (ETag-conditional read), not a DB
--      declared value. Apple's request uses this computed SHA.
--   2. Attempts are append-only. submission_id is globally unique (Apple-issued UUID).
--      Concurrent InProgress → same logical/attempt; Accepted → idempotent return;
--      Invalid/Rejected/clear infra terminal → new attempt.
--   3. App ownership is provable from the local ledger (app_id on both tables).
--      Poll/log endpoints query WHERE app_id=? AND submission_id=? before hitting Apple.
--   4. ready_for_staple requires triple closure: Accepted + jobId==submission_id +
--      log sha256==source computed_sha256. Enforced in application logic, not a DB default.
--
-- Secrets discipline (hard rule): temporary AWS credentials (awsAccessKeyId,
-- awsSecretAccessKey, awsSessionToken), developerLogUrl, and the .p8 key are NEVER
-- stored in D1, operation_logs output, audit payload, or API response.

-- ──────────── logical notarization (source snapshot) ────────────

CREATE TABLE IF NOT EXISTS app_notarizations (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id              TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,

  -- Source asset snapshot (frozen at creation; drift = fail closed).
  -- computed_sha256 is derived from actual R2 bytes via ETag-conditional read,
  -- MUST equal build_assets.file_hash at submit time. r2_etag locks the bytes
  -- so a concurrent overwrite between hash-compute and upload is detected.
  asset_id              TEXT NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  r2_key                TEXT NOT NULL,
  r2_etag               TEXT NOT NULL,
  source_size_bytes     INTEGER NOT NULL,
  computed_sha256       TEXT NOT NULL,
  source_filetype       TEXT NOT NULL,            -- 'dmg' | 'zip' | 'pkg' (darwin only)

  -- Logical state (projection of the latest attempt's terminal outcome).
  state                 TEXT NOT NULL DEFAULT 'pending',
    -- pending | in_progress | accepted | invalid | rejected | error

  -- Triple closure fields (only set when ready_for_staple flips to 1).
  -- See constraint 4: Accepted + jobId==submission_id + log sha256==computed_sha256.
  ready_for_staple      INTEGER NOT NULL DEFAULT 0,
  apple_log_sha256      TEXT,                     -- from Apple's terminal log JSON
  apple_log_job_id      TEXT,                     -- must == the accepted attempt's submission_id

  -- The currently active attempt (latest non-superseded).
  -- Accepted → frozen; Invalid/Rejected/error → new attempt allowed.
  active_attempt_id     TEXT REFERENCES app_notarization_attempts(id) ON DELETE SET NULL,

  created_by_actor      TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  completed_at          INTEGER
);

-- Idempotency: at most one non-terminal logical notarization per (app_id, asset_id, computed_sha256).
-- A terminal logical row stays for audit; a new logical row for the same SHA after terminal
-- failure is a fresh notarization (different id), not a retry of the old one.
-- Retries within the same logical notarization create new ATTEMPTS, not new logical rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notarizations_active
  ON app_notarizations(app_id, asset_id, computed_sha256)
  WHERE state IN ('pending', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_notarizations_app
  ON app_notarizations(app_id, created_at DESC);

-- ──────────── append-only attempts (one per Apple submission) ────────────

CREATE TABLE IF NOT EXISTS app_notarization_attempts (
  id                    TEXT PRIMARY KEY,
  notarization_id       TEXT NOT NULL REFERENCES app_notarizations(id) ON DELETE CASCADE,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,  -- denormalized for ownership check

  attempt_no            INTEGER NOT NULL,         -- 1-based, increments per logical notarization
  operation_id          TEXT NOT NULL REFERENCES operation_logs(id) ON DELETE CASCADE,

  -- Apple submission identity (globally unique UUID, Apple-issued).
  -- NULL until POST /notary/v2/submissions succeeds.
  apple_submission_id   TEXT UNIQUE,

  -- Attempt lifecycle (mirrors Apple's state machine + our upload step).
  upload_state          TEXT NOT NULL DEFAULT 'pending',
    -- pending | uploading | uploaded | upload_failed | upload_uncertain
  status_state          TEXT NOT NULL DEFAULT 'pending',
    -- pending | in_progress | accepted | invalid | rejected | error
    -- (accepted/invalid/rejected are Apple terminal; error is our infra failure)

  -- Terminal error classification (per XX: 401/403/7000 must be distinct).
  -- NULL when no error. Never contains secrets or raw Apple response bodies.
  error_class           TEXT,
    -- NOTARY_AUTH_INVALID | NOTARY_ROLE_INSUFFICIENT | NOTARY_TEAM_NOT_CONFIGURED
    -- (Apple 7000) | APPLE_REQUEST_FAILED | S3_UPLOAD_FAILED | SHA_BINDING_MISMATCH
    -- | UNKNOWN
  error_detail          TEXT,                     -- sanitized, human-readable, no secrets

  -- Log receipt (only when status_state=accepted and log fetched successfully).
  -- The log SHA must match the parent logical row's computed_sha256 for the triple closure.
  log_fetched           INTEGER NOT NULL DEFAULT 0,
  log_sha256            TEXT,                     -- from Apple log JSON archiveHash/sha256
  log_job_id            TEXT,                     -- must == apple_submission_id for closure

  -- Timestamps for the attempt lifecycle.
  created_at            INTEGER NOT NULL,
  submitted_at          INTEGER,                  -- POST /submissions success
  uploaded_at           INTEGER,                  -- S3 PUT success
  completed_at          INTEGER                   -- terminal status or error
);

-- Ownership lookup: GET /apps/:appId/notarizations/:submissionId queries this first.
CREATE INDEX IF NOT EXISTS idx_attempts_app_submission
  ON app_notarization_attempts(app_id, apple_submission_id)
  WHERE apple_submission_id IS NOT NULL;

-- Attempts per logical notarization, ordered.
CREATE INDEX IF NOT EXISTS idx_attempts_notarization
  ON app_notarization_attempts(notarization_id, attempt_no);

-- ──────────── operation_logs.kind extension ────────────
-- The operation_logs.kind column needs 'notarize' added to its allowed values.
-- This is a CHECK constraint change if one exists, or just application-level
-- if kind is free-text. Check the current schema; if there's a CHECK, alter it.
-- (Most likely kind is TEXT without CHECK in Hands — same as testflight-upload
-- was added without a migration. Verify before relying on this.)
