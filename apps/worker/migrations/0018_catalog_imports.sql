-- Declared catalog identities are scoped to an account workspace. Import never
-- proves hostname/repository ownership and never creates ingestion credentials.
CREATE TABLE IF NOT EXISTS catalog_project_imports (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  catalog_id TEXT NOT NULL,
  catalog_name TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id),
  repository TEXT,
  hostname TEXT,
  lifecycle TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'declared' CHECK (verification_state = 'declared'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, catalog_id),
  UNIQUE (workspace_id, app_id)
);

CREATE TRIGGER IF NOT EXISTS catalog_import_scope
BEFORE INSERT ON catalog_project_imports
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
  WHERE wa.workspace_id = NEW.workspace_id AND wa.app_id = NEW.app_id
    AND a.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'catalog import project scope mismatch');
END;

CREATE TRIGGER IF NOT EXISTS catalog_import_identity
BEFORE UPDATE ON catalog_project_imports
WHEN NEW.workspace_id <> OLD.workspace_id OR NEW.catalog_id <> OLD.catalog_id
  OR NEW.app_id <> OLD.app_id OR NEW.payload_sha256 <> OLD.payload_sha256
BEGIN
  SELECT RAISE(ABORT, 'catalog import identity conflict');
END;
