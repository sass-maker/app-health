-- Short-lived, workspace-scoped state for resumable browser archive audits.
CREATE TABLE IF NOT EXISTS browser_archive_audit_jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  india_day TEXT NOT NULL CHECK (length(india_day) = 10),
  identity_salt TEXT NOT NULL CHECK (length(identity_salt) = 64),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'finished', 'incomplete')),
  phase TEXT NOT NULL CHECK (phase IN ('receipts', 'archive_index', 'finalize', 'done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  receipt_high_water INTEGER NOT NULL,
  expected_receipts INTEGER NOT NULL,
  receipt_cursor INTEGER NOT NULL DEFAULT 0,
  receipts_processed INTEGER NOT NULL DEFAULT 0,
  slice_failures INTEGER NOT NULL DEFAULT 0,
  shard_state_json TEXT NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0,
  archive_fact_count INTEGER NOT NULL DEFAULT 0,
  incomplete_reasons_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (workspace_id, india_day)
);
CREATE INDEX IF NOT EXISTS idx_browser_archive_audit_jobs_pending
  ON browser_archive_audit_jobs (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_archive_audit_jobs_one_active_workspace
  ON browser_archive_audit_jobs (workspace_id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_browser_archive_audit_jobs_expiry
  ON browser_archive_audit_jobs (expires_at);

CREATE TABLE IF NOT EXISTS browser_archive_audit_facts (
  job_id TEXT NOT NULL REFERENCES browser_archive_audit_jobs(job_id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  has_receipt INTEGER NOT NULL DEFAULT 0 CHECK (has_receipt IN (0, 1)),
  receipt_digest_version INTEGER,
  receipt_digest TEXT,
  archive_count INTEGER NOT NULL DEFAULT 0,
  archive_in_day INTEGER NOT NULL DEFAULT 0 CHECK (archive_in_day IN (0, 1)),
  archive_digest_version INTEGER,
  archive_digest TEXT,
  PRIMARY KEY (job_id, identity_hash)
);

CREATE TABLE IF NOT EXISTS browser_archive_audit_segments (
  job_id TEXT NOT NULL REFERENCES browser_archive_audit_jobs(job_id) ON DELETE CASCADE,
  segment_hash TEXT NOT NULL CHECK (length(segment_hash) = 64),
  PRIMARY KEY (job_id, segment_hash)
);
