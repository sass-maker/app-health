CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor', 'viewer')),
  verifier_hash TEXT NOT NULL UNIQUE CHECK(length(verifier_hash) = 64),
  created_by TEXT NOT NULL REFERENCES "user"(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  accepted_at INTEGER,
  accepted_by TEXT REFERENCES "user"(id)
);
CREATE INDEX IF NOT EXISTS workspace_invites_scope ON workspace_invites(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS workspace_api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'manage')),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND length(scopes_json) <= 16384),
  verifier_hash TEXT NOT NULL UNIQUE CHECK(length(verifier_hash) = 64),
  created_by TEXT NOT NULL REFERENCES "user"(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS workspace_api_tokens_scope ON workspace_api_tokens(workspace_id, created_at);
INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at FROM workspaces;
