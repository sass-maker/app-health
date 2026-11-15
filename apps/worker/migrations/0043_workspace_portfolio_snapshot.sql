CREATE TABLE IF NOT EXISTS workspace_portfolio_snapshots (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK (source = 'saas-maker'),
  source_catalog_schema_version INTEGER NOT NULL CHECK (source_catalog_schema_version = 2),
  projects_json TEXT NOT NULL CHECK (json_valid(projects_json) AND json_type(projects_json) = 'array'),
  projection_hash TEXT NOT NULL CHECK (length(projection_hash) = 64),
  expected_previous_hash TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_portfolio_sync_guards (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  projects_json TEXT NOT NULL CHECK (json_valid(projects_json)),
  projection_hash TEXT NOT NULL,
  expected_previous_hash TEXT,
  preserve_outside_catalog_app_ids_json TEXT NOT NULL CHECK (json_valid(preserve_outside_catalog_app_ids_json))
);

CREATE TRIGGER IF NOT EXISTS portfolio_sync_guard
BEFORE INSERT ON workspace_portfolio_sync_guards
BEGIN
  SELECT RAISE(ABORT, 'portfolio sync unlinked project') WHERE EXISTS (
    SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
    WHERE wa.workspace_id = NEW.workspace_id AND a.archived_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = wa.workspace_id AND c.app_id = a.id
    ) AND NOT EXISTS (SELECT 1 FROM json_each(NEW.preserve_outside_catalog_app_ids_json) outside_app WHERE outside_app.value = a.id)
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.preserve_outside_catalog_app_ids_json) outside_app WHERE NOT EXISTS (
      SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
      WHERE wa.workspace_id = NEW.workspace_id AND a.id = outside_app.value AND a.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = wa.workspace_id AND c.app_id = a.id)
    )
  );
  SELECT RAISE(ABORT, 'portfolio sync stale snapshot') WHERE
    COALESCE((SELECT projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = NEW.workspace_id), '')
      <> COALESCE(NEW.expected_previous_hash, '')
    AND COALESCE((SELECT projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = NEW.workspace_id), '') <> NEW.projection_hash;
  SELECT RAISE(ABORT, 'portfolio sync identity conflict') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.projects_json) p
    WHERE
      (json_extract(p.value, '$.is_new') = 1 AND (
        EXISTS (SELECT 1 FROM apps WHERE id = json_extract(p.value, '$.app_id')) OR
        EXISTS (SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = NEW.workspace_id AND c.catalog_id = json_extract(p.value, '$.catalog_id'))
      )) OR
      (json_extract(p.value, '$.is_new') = 0 AND NOT EXISTS (
        SELECT 1 FROM catalog_project_imports c
        JOIN workspace_apps wa ON wa.app_id = c.app_id AND wa.workspace_id = c.workspace_id
        JOIN apps a ON a.id = c.app_id AND a.archived_at IS NULL
        WHERE c.workspace_id = NEW.workspace_id AND c.catalog_id = json_extract(p.value, '$.catalog_id') AND c.app_id = json_extract(p.value, '$.app_id')
      ))
  );
END;

CREATE TRIGGER IF NOT EXISTS portfolio_snapshot_insert_scope
BEFORE INSERT ON workspace_portfolio_snapshots
BEGIN
  SELECT RAISE(ABORT, 'portfolio sync identity conflict') WHERE NOT EXISTS (
    SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = NEW.workspace_id AND g.projection_hash = NEW.projection_hash
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.projects_json) p WHERE NOT EXISTS (
      SELECT 1 FROM catalog_project_imports c
      JOIN workspace_apps wa ON wa.app_id = c.app_id AND wa.workspace_id = c.workspace_id
      JOIN apps a ON a.id = c.app_id AND a.archived_at IS NULL
      WHERE c.workspace_id = NEW.workspace_id AND c.catalog_id = json_extract(p.value, '$.catalog_id') AND c.app_id = json_extract(p.value, '$.app_id')
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS portfolio_snapshot_update_scope
BEFORE UPDATE ON workspace_portfolio_snapshots
BEGIN
  SELECT RAISE(ABORT, 'portfolio sync stale snapshot') WHERE NEW.workspace_id <> OLD.workspace_id OR
    (COALESCE(NEW.expected_previous_hash, '') <> OLD.projection_hash AND NEW.projection_hash <> OLD.projection_hash);
  SELECT RAISE(ABORT, 'portfolio sync identity conflict') WHERE NOT EXISTS (
    SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = NEW.workspace_id AND g.projection_hash = NEW.projection_hash
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.projects_json) p WHERE NOT EXISTS (
      SELECT 1 FROM catalog_project_imports c
      JOIN workspace_apps wa ON wa.app_id = c.app_id AND wa.workspace_id = c.workspace_id
      JOIN apps a ON a.id = c.app_id AND a.archived_at IS NULL
      WHERE c.workspace_id = NEW.workspace_id AND c.catalog_id = json_extract(p.value, '$.catalog_id') AND c.app_id = json_extract(p.value, '$.app_id')
    )
  );
END;

CREATE TRIGGER IF NOT EXISTS catalog_snapshot_explicit_link
BEFORE INSERT ON catalog_project_imports
WHEN EXISTS (SELECT 1 FROM workspace_portfolio_snapshots s WHERE s.workspace_id = NEW.workspace_id)
  AND NOT EXISTS (SELECT 1 FROM workspace_portfolio_sync_guards g WHERE g.workspace_id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'catalog import identity conflict') WHERE EXISTS (
    SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = NEW.workspace_id
      AND (c.app_id = NEW.app_id OR c.catalog_id = NEW.catalog_id)
  );
END;

CREATE VIEW IF NOT EXISTS current_workspace_catalog AS
SELECT s.workspace_id, json_extract(p.value, '$.catalog_id') AS catalog_id,
  json_extract(p.value, '$.app_id') AS app_id, json_extract(p.value, '$.name') AS catalog_name,
  json_extract(p.value, '$.repository') AS repository, json_extract(p.value, '$.hostname') AS hostname,
  'active' AS lifecycle, 'declared' AS verification_state,
  json_extract(p.value, '$.kind') AS kind, json_extract(p.value, '$.future_form') AS future_form,
  json_extract(p.value, '$.auth_model') AS auth_model, CAST(p.key AS INTEGER) AS ordinal,
  json_extract(p.value, '$.browser_visitors') AS browser_visitors,
  json_extract(p.value, '$.native_sessions') AS native_sessions,
  json_extract(p.value, '$.server_requests') AS server_requests
FROM workspace_portfolio_snapshots s, json_each(s.projects_json) p
UNION ALL
SELECT c.workspace_id, c.catalog_id, c.app_id, c.catalog_name, c.repository, c.hostname,
  c.lifecycle, c.verification_state, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM catalog_project_imports c
WHERE c.lifecycle IN ('active', 'primary') AND NOT EXISTS (
  SELECT 1 FROM workspace_portfolio_snapshots s WHERE s.workspace_id = c.workspace_id
);
