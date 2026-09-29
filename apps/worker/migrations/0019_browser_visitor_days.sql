-- Exact, short-retention daily unique browser set for newly accepted batches.
-- Raw visitor IDs are never stored; visitor_hash is already app/environment scoped.
CREATE TABLE IF NOT EXISTS browser_visitor_rollup_meta (
  workspace_id TEXT PRIMARY KEY,
  first_receipt_at INTEGER NOT NULL,
  source_cutover_at INTEGER,
  reconciled_through INTEGER,
  verified_at INTEGER,
  CHECK ((source_cutover_at IS NULL) = (reconciled_through IS NULL)),
  CHECK ((source_cutover_at IS NULL) = (verified_at IS NULL))
);

CREATE TABLE IF NOT EXISTS browser_visitor_batch_receipts (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id, environment_id, batch_id),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_batch_receipts_expiry
  ON browser_visitor_batch_receipts (expires_at);

CREATE TABLE IF NOT EXISTS browser_visitor_days (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  india_day TEXT NOT NULL CHECK (length(india_day) = 10),
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id, environment_id, india_day, visitor_hash),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_days_expiry
  ON browser_visitor_days (expires_at);
