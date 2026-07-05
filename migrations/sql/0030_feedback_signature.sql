ALTER TABLE feedback_tickets ADD COLUMN signature TEXT;

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_signature
  ON feedback_tickets(app_id, signature, created_at DESC);
