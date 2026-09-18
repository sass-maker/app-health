-- Workspace membership and declared project sources (issue #58 task 3).
-- Additive and replayable: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE.
-- workspaces.owner_id stays authoritative for ownership; membership rows let a
-- workspace admit additional accounts later without restructuring.
-- project/app ownership itself already lives in apps, environments,
-- workspace_apps, and environment_capabilities (instrumentation policy).

-- One row per (workspace, account) beyond the owner. role is bounded so a
-- member can never widen past the documented set without a schema change.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  user_id TEXT NOT NULL REFERENCES "user" (id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON workspace_members (user_id);

-- Existing workspaces seed their owner as a member so reads never need a
-- legacy "owner_id OR membership" union.
INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, created_at)
SELECT id, owner_id, 'owner', created_at FROM workspaces;

-- Declared onboarding sources per project. A project may expose several
-- sources (e.g. a marketing site plus its backend); each row is the user's
-- explicit declaration that drives install instructions — never an observed
-- telemetry fact, which lives in environment_capabilities instead.
CREATE TABLE IF NOT EXISTS project_sources (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps (id),
  environment_id TEXT REFERENCES environments (id),
  kind TEXT NOT NULL CHECK (kind IN ('web', 'backend', 'mobile', 'repository', 'manual')),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (app_id, environment_id, kind)
);
CREATE INDEX IF NOT EXISTS project_sources_app ON project_sources (app_id);
