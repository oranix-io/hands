CREATE TABLE IF NOT EXISTS release_share_events (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL REFERENCES release_shares(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('view', 'download')),
  visitor_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_release_share_events_share_type
  ON release_share_events(share_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_release_share_events_unique
  ON release_share_events(share_id, event_type, visitor_hash);
