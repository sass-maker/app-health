-- Durable adoption metadata only; no raw telemetry. Historical receipt survives retention.
CREATE TABLE IF NOT EXISTS environment_capabilities (
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('analytics', 'endpoints', 'logs')),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  first_received_at INTEGER,
  last_received_at INTEGER,
  PRIMARY KEY (app_id, environment_id, capability),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);
INSERT OR IGNORE INTO environment_capabilities
  (app_id, environment_id, capability, enabled, first_received_at, last_received_at)
SELECT app_id, environment_id, 'endpoints', 1, first_seen, last_seen
FROM installation_status WHERE first_seen IS NOT NULL;
INSERT OR IGNORE INTO environment_capabilities
  (app_id, environment_id, capability, enabled, first_received_at, last_received_at)
SELECT app_id, environment_id, 'logs', 1, MIN(timestamp), MAX(timestamp)
FROM log_events GROUP BY app_id, environment_id;
