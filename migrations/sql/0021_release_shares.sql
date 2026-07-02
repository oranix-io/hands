CREATE TABLE IF NOT EXISTS release_shares (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_release_shares_release
  ON release_shares(release_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_shares_token_active
  ON release_shares(token_hash, expires_at, revoked_at);
