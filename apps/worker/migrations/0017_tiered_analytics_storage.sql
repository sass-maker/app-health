-- Durable metadata for lossless archive replacement and mergeable graph rollups.
-- Raw browser/product facts remain in R2; these tables index physical lineage
-- and compact time-series states without turning D1 into a raw event store.
CREATE TABLE IF NOT EXISTS analytics_archive_segments (
  object_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('jsonl-gzip', 'parquet-iceberg')),
  schema_version INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  min_event_at INTEGER NOT NULL,
  max_event_at INTEGER NOT NULL,
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes > 0),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'replacement-written', 'superseded')),
  replacement_key TEXT,
  verified_at INTEGER,
  CHECK (max_event_at >= min_event_at),
  CHECK (state = 'active' OR replacement_key IS NOT NULL),
  CHECK (state != 'superseded' OR verified_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_analytics_archive_segments_workspace_time
  ON analytics_archive_segments (workspace_id, min_event_at, max_event_at);
CREATE INDEX IF NOT EXISTS idx_analytics_archive_segments_state
  ON analytics_archive_segments (state, created_at);

CREATE TABLE IF NOT EXISTS analytics_rollups (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('web', 'product', 'api', 'logs')),
  resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
  bucket_start INTEGER NOT NULL,
  metric TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  sum REAL,
  histogram BLOB,
  distinct_sketch BLOB,
  rollup_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    workspace_id, app_id, environment_id, product, resolution,
    bucket_start, metric, dimension_key
  ),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_analytics_rollups_range
  ON analytics_rollups (
    workspace_id, app_id, environment_id, product, resolution, metric, bucket_start
  );

-- A source segment can affect more than one event-time bucket. The receipt is
-- inserted in the same D1 transaction as its rollup deltas, making retries
-- idempotent without assuming Queue exactly-once delivery.
CREATE TABLE IF NOT EXISTS analytics_compaction_receipts (
  source_key TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
  bucket_start INTEGER NOT NULL,
  rollup_version INTEGER NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (source_key, resolution, bucket_start, rollup_version),
  FOREIGN KEY (source_key) REFERENCES analytics_archive_segments (object_key)
);

CREATE INDEX IF NOT EXISTS idx_analytics_compaction_receipts_bucket
  ON analytics_compaction_receipts (resolution, bucket_start, applied_at);

CREATE TABLE IF NOT EXISTS analytics_rollup_repairs (
  workspace_id TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
  bucket_start INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('late-event', 'schema-upgrade', 'reconciliation')),
  PRIMARY KEY (workspace_id, resolution, bucket_start)
);
