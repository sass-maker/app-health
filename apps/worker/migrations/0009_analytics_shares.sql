-- Revocable anonymous analytics links. Only a SHA-256 token verifier is stored.
CREATE TABLE IF NOT EXISTS analytics_shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS analytics_shares_scope_created
  ON analytics_shares (workspace_id, app_id, environment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_shares_token_hash
  ON analytics_shares (token_hash);
