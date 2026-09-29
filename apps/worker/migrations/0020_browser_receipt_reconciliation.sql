-- Retain a bounded, privacy-safe day index for accepted browser batch receipts.
ALTER TABLE browser_visitor_batch_receipts ADD COLUMN accepted_at INTEGER;
ALTER TABLE browser_visitor_batch_receipts ADD COLUMN event_count INTEGER;

CREATE TABLE IF NOT EXISTS browser_visitor_receipt_days (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  india_day TEXT NOT NULL CHECK (length(india_day) = 10),
  PRIMARY KEY (workspace_id, app_id, environment_id, batch_id, india_day),
  FOREIGN KEY (workspace_id, app_id, environment_id, batch_id)
    REFERENCES browser_visitor_batch_receipts (workspace_id, app_id, environment_id, batch_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_receipt_days_lookup
  ON browser_visitor_receipt_days (workspace_id, india_day, app_id, environment_id, batch_id);
