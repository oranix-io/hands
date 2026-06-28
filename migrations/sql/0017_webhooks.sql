-- Migration 0017: webhooks + delivery queue (P2.5.8)
--
-- Tables:
--   webhooks           -- subscriptions per org (or per app in v2)
--   webhook_deliveries -- per-event delivery records + retry state
--
-- Design:
--   - webhooks are scoped by (org_id, scope_type, scope_value):
--       scope_type='org'   scope_value=org_id        (org-wide)
--       scope_type='app'   scope_value=app_id        (per-app)
--   - events are: 'release:new' | 'release:superseded' | 'release:rolled_back'
--                  'release:cancelled' | 'build:succeeded' | 'build:failed'
--   - delivery payload includes a stable id + timestamp + JSON body
--   - delivery state machine: pending → succeeded | failed (with retry_count + last_attempt_at)
--   - retry policy: 3 attempts, exponential backoff (5min / 30min / 2h)
--   - worker (Worker Cron Trigger) reaps pending+failed+retry-eligible deliveries
--   - HMAC signature header (X-Quiver-Signature: sha256=...) for receivers

-- ---------- webhooks ----------

CREATE TABLE IF NOT EXISTS webhooks (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id              TEXT REFERENCES apps(id) ON DELETE CASCADE,        -- NULL = org-wide
  url                 TEXT NOT NULL,
  secret              TEXT NOT NULL,                                       -- HMAC secret (plaintext for v1; encrypt v2)
  events_json         TEXT NOT NULL DEFAULT '[]',                          -- JSON array of subscribed event types
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_by          TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  archived_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org
  ON webhooks(org_id, archived_at);

CREATE INDEX IF NOT EXISTS idx_webhooks_app
  ON webhooks(app_id) WHERE app_id IS NOT NULL;

-- ---------- webhook_deliveries ----------

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id                  TEXT PRIMARY KEY,
  webhook_id          TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,                  -- 'release:new' | 'build:succeeded' | ...
  payload_json        TEXT NOT NULL,                  -- full JSON body sent to receiver
  status              TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'succeeded' | 'failed'
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  last_attempt_at     INTEGER,
  next_attempt_at     INTEGER,                       -- for backoff scheduling
  last_response_status INTEGER,                       -- HTTP status from last attempt
  last_response_body   TEXT,                           -- truncated body for debugging
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_deliveries_pending
  ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_deliveries_webhook
  ON webhook_deliveries(webhook_id, created_at DESC);

-- ---------- Worker Cron Trigger (reap + retry) ----------
--
-- Set in wrangler.jsonc:
--   "triggers": [{ "type": "scheduled", "cron": "*/5 * * * *" }]
--
-- The handler:
--   1. SELECT deliveries WHERE status='pending' AND next_attempt_at <= now()
--   2. POST payload + X-Quiver-Signature header to webhook.url
--   3. Update status='succeeded' on 2xx, 'failed' on 4xx/5xx/network error
--   4. On failure: attempts++, schedule next_attempt_at with backoff
--                  (5min / 30min / 2h); after max_attempts mark 'failed' permanently
--   5. Emit 'release:new' / 'release:superseded' etc. events from
--      audit_logs OR from a dedicated hook in the release endpoints

-- ---------- Backfill: link existing orgs so webhook CRUD has something to scope to ----------
--
-- (no backfill needed — webhooks are new functionality)