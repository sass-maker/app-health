ALTER TABLE browser_archive_audit_facts
  ADD COLUMN queue_stage_observed INTEGER NOT NULL DEFAULT 0 CHECK (queue_stage_observed IN (0, 1));
