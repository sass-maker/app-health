-- Owner reads filter log_events by event or level inside the 30-day window.
-- Without these indexes SQLite walks every retained row in the time range
-- (idx_log_events_expiry) or every row of an app (idx_log_events_scope_time).
-- On 2026-10-09 one app's info `traffic.summary` was 99.5% of ~370k rows, so
-- each /v1/workspace/alerts read scanned ~860k rows (~1.5-2.5 s of D1 SQL).
-- Additive; no data change.
CREATE INDEX IF NOT EXISTS idx_log_events_event_time ON log_events (event, timestamp);
CREATE INDEX IF NOT EXISTS idx_log_events_level_time ON log_events (level, timestamp);
