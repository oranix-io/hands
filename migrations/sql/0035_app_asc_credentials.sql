-- Migration 0035: per-app App Store Connect API credentials for Hands-orchestrated
-- TestFlight uploads.
--
-- Hands (not the app's CI) holds the ASC API key so the "Upload to TestFlight"
-- action can run server-side (via the Container + iTMSTransporter). The .p8
-- private key is stored ENCRYPTED (AES-GCM) — unlike deploy tokens (hashed),
-- this must be reversible because iTMSTransporter needs the real key to
-- authenticate. Key id / issuer id are non-secret identifiers, stored plain.
--
-- One credential set per app (UNIQUE app_id). Rotating = overwrite.

CREATE TABLE IF NOT EXISTS app_asc_credentials (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  key_id            TEXT NOT NULL,
  issuer_id         TEXT NOT NULL,
  -- AES-GCM encrypted .p8 private key + its random IV, both base64.
  p8_ciphertext_b64 TEXT NOT NULL,
  p8_iv_b64         TEXT NOT NULL,
  created_by_actor  TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
