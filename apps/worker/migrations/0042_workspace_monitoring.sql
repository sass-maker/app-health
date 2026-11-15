CREATE TABLE IF NOT EXISTS workspace_monitoring_projects (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  catalog_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('public', 'local', 'private')),
  reason TEXT,
  journeys_json TEXT NOT NULL CHECK (json_valid(journeys_json)),
  updated_at INTEGER NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY (workspace_id, catalog_id)
);

CREATE TABLE IF NOT EXISTS workspace_monitoring_runs (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  lease_id TEXT NOT NULL,
  lease_started_at INTEGER NOT NULL,
  committed_lease_id TEXT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
