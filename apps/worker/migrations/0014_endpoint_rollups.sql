-- Durable endpoint measurements; no raw successful request rows or payloads.
-- Apply before deploying the durable ingest writer. No historical backfill is implied.
CREATE TABLE IF NOT EXISTS endpoint_receipts (
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, environment_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_endpoint_receipts_expiry ON endpoint_receipts (seen_at);

CREATE TABLE IF NOT EXISTS endpoint_rollups (
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  resolution_ms INTEGER NOT NULL CHECK (resolution_ms IN (60000, 3600000, 86400000)),
  bucket_start INTEGER NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  runtime TEXT NOT NULL,
  release TEXT NOT NULL,
  histogram_bounds_ms TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  error_count INTEGER NOT NULL CHECK (error_count BETWEEN 0 AND request_count),
  duration_sum_ms REAL NOT NULL CHECK (duration_sum_ms >= 0),
  last_seen INTEGER NOT NULL,
  upstream_sampled INTEGER NOT NULL,
  h0 INTEGER NOT NULL CHECK (h0 >= 0),
  h1 INTEGER NOT NULL CHECK (h1 >= 0),
  h2 INTEGER NOT NULL CHECK (h2 >= 0),
  h3 INTEGER NOT NULL CHECK (h3 >= 0),
  h4 INTEGER NOT NULL CHECK (h4 >= 0),
  h5 INTEGER NOT NULL CHECK (h5 >= 0),
  h6 INTEGER NOT NULL CHECK (h6 >= 0),
  h7 INTEGER NOT NULL CHECK (h7 >= 0),
  h8 INTEGER NOT NULL CHECK (h8 >= 0),
  h9 INTEGER NOT NULL CHECK (h9 >= 0),
  h10 INTEGER NOT NULL CHECK (h10 >= 0),
  h11 INTEGER NOT NULL CHECK (h11 >= 0),
  h12 INTEGER NOT NULL CHECK (h12 >= 0),
  h13 INTEGER NOT NULL CHECK (h13 >= 0),
  h14 INTEGER NOT NULL CHECK (h14 >= 0),
  h15 INTEGER NOT NULL CHECK (h15 >= 0),
  PRIMARY KEY (app_id, environment_id, resolution_ms, bucket_start, method, route, runtime, release, histogram_bounds_ms)
);
