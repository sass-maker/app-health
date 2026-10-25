-- Control-plane definitions only. Browser event payloads stay in R2.
CREATE TABLE IF NOT EXISTS analytics_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  app_id TEXT NOT NULL REFERENCES apps(id),
  environment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('goal', 'funnel', 'segment')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  definition_json TEXT NOT NULL CHECK(length(definition_json) <= 16384 AND json_valid(definition_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(environment_id, app_id) REFERENCES environments(id, app_id)
);
CREATE INDEX IF NOT EXISTS analytics_definitions_scope
  ON analytics_definitions(workspace_id, app_id, environment_id, created_at, id);
CREATE TRIGGER IF NOT EXISTS analytics_definitions_owner
BEFORE INSERT ON analytics_definitions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM workspace_apps WHERE workspace_id = NEW.workspace_id AND app_id = NEW.app_id
  ) THEN RAISE(ABORT, 'analysis project scope mismatch') END;
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM analytics_definitions
    WHERE workspace_id = NEW.workspace_id AND app_id = NEW.app_id AND environment_id = NEW.environment_id
  ) >= 100 THEN RAISE(ABORT, 'analysis definition limit reached') END;
END;
CREATE TRIGGER IF NOT EXISTS analytics_definitions_identity
BEFORE UPDATE OF id, workspace_id, app_id, environment_id ON analytics_definitions
BEGIN
  SELECT RAISE(ABORT, 'analysis scope is immutable');
END;
