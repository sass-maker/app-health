-- Acceptance-native coverage evidence for exact browser visitor days.
-- Archive reconciliation remains in browser_visitor_rollup_meta and is independent.
CREATE TABLE IF NOT EXISTS browser_visitor_acceptance_rollouts (
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  worker_version_id TEXT NOT NULL,
  source_sha TEXT NOT NULL CHECK (
    length(source_sha) = 40 AND source_sha NOT GLOB '*[^0-9a-f]*'
  ),
  rollout_started_at INTEGER NOT NULL,
  rollout_observed_at INTEGER NOT NULL,
  rollout_traffic_percent INTEGER NOT NULL CHECK (rollout_traffic_percent BETWEEN 0 AND 100),
  full_traffic_at INTEGER,
  full_traffic_observed_at INTEGER,
  full_traffic_percent INTEGER CHECK (full_traffic_percent IS NULL OR full_traffic_percent = 100),
  PRIMARY KEY (workspace_id, generation_id),
  CHECK (rollout_observed_at >= rollout_started_at),
  CHECK (
    (full_traffic_at IS NULL AND full_traffic_observed_at IS NULL AND full_traffic_percent IS NULL)
    OR
    (full_traffic_at IS NOT NULL AND full_traffic_observed_at IS NOT NULL
      AND full_traffic_observed_at >= full_traffic_at
      AND full_traffic_at >= rollout_started_at AND full_traffic_percent = 100)
  )
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_acceptance_rollouts_window
  ON browser_visitor_acceptance_rollouts (workspace_id, full_traffic_at);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_acceptance_rollouts_started
  ON browser_visitor_acceptance_rollouts (workspace_id, rollout_started_at);

-- Tracker activation is explicit per production app/environment and can be
-- closed when instrumentation is removed or disabled. The product source SHA
-- and verification time identify the attested tracker state.
CREATE TABLE IF NOT EXISTS browser_visitor_scope_activations (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  tracker_source_sha TEXT NOT NULL CHECK (
    length(tracker_source_sha) = 40 AND tracker_source_sha NOT GLOB '*[^0-9a-f]*'
  ),
  deactivated_at INTEGER,
  PRIMARY KEY (workspace_id, app_id, environment_id, activated_at, tracker_source_sha),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id),
  CHECK (verified_at >= activated_at),
  CHECK (deactivated_at IS NULL OR deactivated_at >= activated_at)
);
CREATE INDEX IF NOT EXISTS idx_browser_visitor_scope_activations_lookup
  ON browser_visitor_scope_activations (workspace_id, app_id, environment_id, activated_at);
