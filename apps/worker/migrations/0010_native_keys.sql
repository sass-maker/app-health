CREATE TABLE native_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id),
  environment_id TEXT NOT NULL REFERENCES environments(id),
  verifier_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX native_keys_scope ON native_keys(workspace_id, app_id, environment_id, revoked_at, created_at);
