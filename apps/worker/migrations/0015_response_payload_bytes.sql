-- Response payload size rollups for endpoint telemetry. Stores only byte
-- counts, never response content. Apply before deploying the writer that
-- reads/writes these columns; existing rows default to zero.
ALTER TABLE endpoint_rollups
  ADD COLUMN response_bytes_sum REAL NOT NULL DEFAULT 0 CHECK (response_bytes_sum >= 0);
ALTER TABLE endpoint_rollups
  ADD COLUMN response_bytes_measured INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes_measured >= 0);
