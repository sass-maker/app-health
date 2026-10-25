ALTER TABLE product_compaction_jobs ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_compaction_jobs ADD COLUMN error_code TEXT;
CREATE INDEX product_compaction_retry ON product_compaction_jobs(retry_at,dirty,closed,event_day,lease_until);
CREATE INDEX product_segment_object ON product_report_segments(object_key,active);
