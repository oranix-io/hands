CREATE TABLE IF NOT EXISTS app_deploy_tokens (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  app_role TEXT NOT NULL CHECK (app_role IN ('publisher', 'viewer')),
  created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_app_deploy_tokens_app
  ON app_deploy_tokens(app_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_app_deploy_tokens_hash
  ON app_deploy_tokens(token_hash);
