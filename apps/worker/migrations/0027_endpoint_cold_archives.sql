-- Verified immutable archive snapshots of endpoint aggregate rows.
-- A NULL source_removed_at means hot rows still exist and this object is shadow-only.
CREATE TABLE IF NOT EXISTS endpoint_cold_archives (
  object_key TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  resolution_ms INTEGER NOT NULL CHECK (resolution_ms IN (60000, 3600000, 86400000)),
  bucket_from INTEGER NOT NULL CHECK (bucket_from >= 0 AND bucket_from % resolution_ms = 0),
  bucket_to INTEGER NOT NULL CHECK (bucket_to > bucket_from AND bucket_to % resolution_ms = 0),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  row_count INTEGER NOT NULL CHECK (row_count > 0),
  uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
  source_removed_at INTEGER CHECK (source_removed_at IS NULL OR source_removed_at >= completed_at),
  UNIQUE (app_id, environment_id, resolution_ms, bucket_from, bucket_to, content_sha256),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_endpoint_cold_archives_range
  ON endpoint_cold_archives (app_id, environment_id, resolution_ms, bucket_from, bucket_to);

-- The retirement planner scans closed time partitions across all scopes.
CREATE INDEX IF NOT EXISTS idx_endpoint_rollups_retirement_window
  ON endpoint_rollups (resolution_ms, bucket_start);
