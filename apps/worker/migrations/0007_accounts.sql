-- Additive account ownership. Existing apps are deliberately unclaimed.
-- Google subjects can never claim legacy apps by being the first to sign in.
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
  createdAt DATE NOT NULL, updatedAt DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY, expiresAt DATE NOT NULL, token TEXT NOT NULL UNIQUE,
  createdAt DATE NOT NULL, updatedAt DATE NOT NULL, ipAddress TEXT, userAgent TEXT,
  userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user ON session (userId);
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  accessToken TEXT, refreshToken TEXT, idToken TEXT,
  accessTokenExpiresAt DATE, refreshTokenExpiresAt DATE, scope TEXT, password TEXT,
  createdAt DATE NOT NULL, updatedAt DATE NOT NULL,
  UNIQUE (providerId, accountId)
);
CREATE INDEX IF NOT EXISTS account_user ON account (userId);
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expiresAt DATE NOT NULL, createdAt DATE NOT NULL, updatedAt DATE NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_identifier ON verification (identifier);
CREATE TABLE IF NOT EXISTS rateLimit (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL,
  lastRequest BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES "user" (id),
  name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_apps (
  app_id TEXT PRIMARY KEY REFERENCES apps (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id)
);
CREATE INDEX IF NOT EXISTS workspace_apps_workspace ON workspace_apps (workspace_id);
