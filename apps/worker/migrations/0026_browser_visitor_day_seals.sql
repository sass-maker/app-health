-- Fail-closed, acceptance-serialized day seals for exact visitor coverage.
-- A complete provider audit is an explicit operator evidence record; elapsed
-- wall time by itself never closes a day.
CREATE TABLE IF NOT EXISTS browser_visitor_coverage_audits (
  workspace_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  audit_kind TEXT NOT NULL CHECK (audit_kind IN ('worker_rollouts', 'tracker_scope')),
  app_id TEXT,
  environment_id TEXT,
  audited_through INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  evidence_sha TEXT NOT NULL CHECK (
    length(evidence_sha) = 64 AND evidence_sha NOT GLOB '*[^0-9a-f]*'
  ),
  PRIMARY KEY (workspace_id, audit_id),
  CHECK (observed_at >= audited_through),
  CHECK (
    (audit_kind = 'worker_rollouts' AND app_id IS NULL AND environment_id IS NULL)
    OR
    (audit_kind = 'tracker_scope' AND app_id IS NOT NULL AND environment_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_coverage_audits_lookup
  ON browser_visitor_coverage_audits
    (workspace_id, audit_kind, app_id, environment_id, audited_through, observed_at);

CREATE TABLE IF NOT EXISTS browser_visitor_acceptance_day_fences (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  india_day TEXT NOT NULL CHECK (length(india_day) = 10),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed')),
  expires_at INTEGER NOT NULL,
  sealed_at INTEGER,
  rollout_generation_id TEXT,
  tracker_activation_at INTEGER,
  tracker_source_sha TEXT,
  worker_audit_id TEXT,
  scope_audit_id TEXT,
  PRIMARY KEY (workspace_id, app_id, environment_id, india_day),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id),
  FOREIGN KEY (workspace_id, worker_audit_id)
    REFERENCES browser_visitor_coverage_audits (workspace_id, audit_id),
  FOREIGN KEY (workspace_id, scope_audit_id)
    REFERENCES browser_visitor_coverage_audits (workspace_id, audit_id),
  CHECK (
    (state = 'open' AND sealed_at IS NULL AND rollout_generation_id IS NULL
      AND tracker_activation_at IS NULL AND tracker_source_sha IS NULL
      AND worker_audit_id IS NULL AND scope_audit_id IS NULL)
    OR
    (state = 'sealed' AND sealed_at IS NOT NULL AND rollout_generation_id IS NOT NULL
      AND tracker_activation_at IS NOT NULL AND tracker_source_sha IS NOT NULL
      AND worker_audit_id IS NOT NULL AND scope_audit_id IS NOT NULL)
  )
);
