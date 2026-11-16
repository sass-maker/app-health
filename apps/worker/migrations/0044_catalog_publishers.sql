CREATE TABLE catalog_publishers (
  id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL UNIQUE,
  pairing_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id),
  approved_at INTEGER,
  revoked_at INTEGER,
  outside_app_ids_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(outside_app_ids_json)),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT CHECK(last_error IN ('invalid_catalog', 'source_unavailable', 'service_unavailable', 'review_required', 'conflict')),
  CHECK((workspace_id IS NULL) = (approved_at IS NULL))
);
CREATE INDEX catalog_publishers_workspace ON catalog_publishers(workspace_id, approved_at);
CREATE TRIGGER catalog_publisher_workspace_immutable
BEFORE UPDATE ON catalog_publishers
WHEN OLD.workspace_id IS NOT NULL AND NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT, 'catalog publisher workspace immutable');
END;
ALTER TABLE workspace_portfolio_sync_guards ADD COLUMN publisher_id TEXT;
ALTER TABLE workspace_portfolio_sync_guards ADD COLUMN publisher_verifier_hash TEXT;
CREATE TRIGGER catalog_publisher_sync_authority
BEFORE INSERT ON workspace_portfolio_sync_guards
WHEN NEW.publisher_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'catalog publisher revoked') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_publishers p WHERE p.id = NEW.publisher_id
      AND p.verifier_hash = NEW.publisher_verifier_hash
      AND p.workspace_id = NEW.workspace_id AND p.approved_at IS NOT NULL AND p.revoked_at IS NULL
      AND p.outside_app_ids_json = NEW.preserve_outside_catalog_app_ids_json
  );
END;

ALTER TABLE workspace_monitoring_projects ADD COLUMN journey_revisions_json TEXT CHECK(journey_revisions_json IS NULL OR json_valid(journey_revisions_json));
