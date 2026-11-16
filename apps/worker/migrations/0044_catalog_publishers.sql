CREATE TABLE catalog_publishers (
  id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL UNIQUE,
  enrollment_key TEXT,
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
  );
  SELECT RAISE(ABORT, 'catalog publisher outside changed') WHERE NOT EXISTS (
    SELECT 1 FROM catalog_publishers p WHERE p.id = NEW.publisher_id
      AND p.outside_app_ids_json = NEW.preserve_outside_catalog_app_ids_json
  );
END;

ALTER TABLE workspace_monitoring_projects ADD COLUMN journey_revisions_json TEXT CHECK(journey_revisions_json IS NULL OR json_valid(journey_revisions_json));

CREATE INDEX catalog_publishers_enrollment ON catalog_publishers(enrollment_key) WHERE workspace_id IS NULL;

ALTER TABLE workspace_portfolio_sync_guards ADD COLUMN monitoring_json TEXT CHECK(monitoring_json IS NULL OR json_valid(monitoring_json));
CREATE TABLE workspace_catalog_revision_fences (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE TRIGGER catalog_revision_upgrade_guard
BEFORE INSERT ON workspace_portfolio_sync_guards
BEGIN
  SELECT RAISE(ABORT, 'catalog revisions required') WHERE (
    NEW.publisher_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM workspace_catalog_revision_fences f WHERE f.workspace_id = NEW.workspace_id)
    OR EXISTS (SELECT 1 FROM json_each(NEW.monitoring_json) p WHERE json_type(p.value, '$.journey_revisions') = 'object')
  ) AND (
    NEW.monitoring_json IS NULL OR EXISTS (
      SELECT 1 FROM json_each(NEW.monitoring_json) p WHERE json_extract(p.value, '$.scope') = 'public'
        AND (json_type(p.value, '$.journey_revisions') IS NOT 'object'
          OR (SELECT count(*) FROM json_each(p.value, '$.journey_revisions')) <> (SELECT count(*) FROM json_each(p.value, '$.journeys'))
          OR EXISTS (SELECT 1 FROM json_each(p.value, '$.journeys') j WHERE NOT EXISTS (
            SELECT 1 FROM json_each(p.value, '$.journey_revisions') r WHERE r.key = j.value AND r.type = 'text')))
    )
  );
  INSERT OR IGNORE INTO workspace_catalog_revision_fences (workspace_id)
    SELECT NEW.workspace_id WHERE NEW.publisher_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM json_each(NEW.monitoring_json) p WHERE json_type(p.value, '$.journey_revisions') = 'object');
END;

CREATE TRIGGER catalog_revision_policy_insert
BEFORE INSERT ON workspace_monitoring_projects
WHEN EXISTS (SELECT 1 FROM workspace_catalog_revision_fences f WHERE f.workspace_id = NEW.workspace_id)
  AND NOT EXISTS (SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'catalog monitoring transaction required');
END;
CREATE TRIGGER catalog_revision_policy_delete
BEFORE DELETE ON workspace_monitoring_projects
WHEN EXISTS (SELECT 1 FROM workspace_catalog_revision_fences f WHERE f.workspace_id = OLD.workspace_id)
  AND NOT EXISTS (SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = OLD.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'catalog monitoring transaction required');
END;
CREATE TRIGGER catalog_revision_policy_update
BEFORE UPDATE ON workspace_monitoring_projects
WHEN (EXISTS (SELECT 1 FROM workspace_catalog_revision_fences f WHERE f.workspace_id = OLD.workspace_id)
  AND NOT EXISTS (SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = OLD.workspace_id))
  OR (EXISTS (SELECT 1 FROM workspace_catalog_revision_fences f WHERE f.workspace_id = NEW.workspace_id)
  AND NOT EXISTS (SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = NEW.workspace_id))
BEGIN
  SELECT RAISE(ABORT, 'catalog monitoring transaction required');
END;
