-- Preserve telemetry and ownership while removing projects from active use.
ALTER TABLE apps ADD COLUMN archived_at INTEGER;
