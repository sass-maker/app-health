-- Positive delivery evidence for batches durably staged by the Queue consumer.
-- This records identities only; event payloads remain in the archive pipeline.
CREATE TABLE IF NOT EXISTS browser_queue_stage_receipts (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  staged_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id, environment_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_browser_queue_stage_receipts_expiry
  ON browser_queue_stage_receipts (expires_at);
