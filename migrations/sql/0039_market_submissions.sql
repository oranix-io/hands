CREATE TABLE market_submissions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'appgallery'),
  lane TEXT NOT NULL CHECK (lane IN ('invitation_test')),
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  external_app_id TEXT,
  external_version_id TEXT,
  external_package_id TEXT,
  provider_state_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_market_submissions_app_created
  ON market_submissions(app_id, created_at DESC);

CREATE TABLE market_submission_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES market_submissions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_market_submission_events_submission
  ON market_submission_events(submission_id, created_at ASC);
