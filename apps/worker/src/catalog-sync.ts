import {
  CatalogSyncRequestV1,
  MAX_CATALOG_OUTSIDE_APPS,
  MAX_CATALOG_LINKED_IDENTITIES,
  CatalogSyncStatusV1,
  type CatalogSyncRequest,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import { readPublicJson } from './public-body.js';
import generated from '../../probe/journeys.json';

export class CatalogSyncConflict extends Error {}
class CatalogSyncLimit extends Error {}
const OUTSIDE_LIMIT_MESSAGE = `Catalog synchronization supports at most ${MAX_CATALOG_OUTSIDE_APPS} outside projects. Link projects that belong to unused canonical catalog identities first; no projects were changed.`;
const json = (status: number, value: unknown) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function catalogSnapshotStatus(db: D1DatabaseLike, workspace: string) {
  const snapshot = await db
    .prepare(
      'SELECT projection_hash, updated_at, json_array_length(projects_json) AS project_count FROM workspace_portfolio_snapshots WHERE workspace_id = ?',
    )
    .bind(workspace)
    .first<{ projection_hash: string; updated_at: number; project_count: number }>();
  return {
    source: snapshot ? 'saas-maker' : null,
    projection_hash: snapshot?.projection_hash ?? null,
    updated_at: snapshot?.updated_at ?? null,
    project_count: snapshot?.project_count ?? null,
  };
}

const UNLINKED_MESSAGE =
  'Review unlinked workspace projects before synchronizing. Link active catalog projects through /v1/catalog/import with existing_app_id, or explicitly acknowledge projects to preserve outside this catalog. Reload the preview after changes.';
async function unlinkedCatalogApps(db: D1DatabaseLike, workspace: string) {
  return (
    await db
      .prepare(
        `SELECT a.id AS app_id, a.name FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
    WHERE wa.workspace_id = ? AND a.archived_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM catalog_project_imports c WHERE c.workspace_id = wa.workspace_id AND c.app_id = a.id
    ) ORDER BY a.name, a.id LIMIT ${MAX_CATALOG_OUTSIDE_APPS + 1}`,
      )
      .bind(workspace)
      .all<{ app_id: string; name: string }>()
  ).results;
}
async function catalogSyncStatus(db: D1DatabaseLike, workspace: string) {
  const [snapshot, mapped, unlinked] = await Promise.all([
    catalogSnapshotStatus(db, workspace),
    db
      .prepare(
        'SELECT catalog_id FROM catalog_project_imports WHERE workspace_id = ? ORDER BY catalog_id LIMIT 1001',
      )
      .bind(workspace)
      .all<{ catalog_id: string }>(),
    unlinkedCatalogApps(db, workspace),
  ]);
  if (unlinked.length > MAX_CATALOG_OUTSIDE_APPS) throw new CatalogSyncLimit(OUTSIDE_LIMIT_MESSAGE);
  if (mapped.results.length > MAX_CATALOG_LINKED_IDENTITIES)
    throw new CatalogSyncLimit(
      `Catalog status supports at most ${MAX_CATALOG_LINKED_IDENTITIES} linked identities. Review the workspace inventory before synchronizing; no projects were changed.`,
    );
  return CatalogSyncStatusV1.parse({
    ...snapshot,
    mapped_catalog_ids: mapped.results.map((row) => row.catalog_id),
    unlinked_apps: unlinked,
  });
}

/** Ownership remains unchanged. A snapshot selects the current portfolio from owned metadata. */
export async function syncCatalog(
  db: D1DatabaseLike,
  workspace: string,
  input: CatalogSyncRequest,
  now: number,
) {
  const reviewed = new Set(generated.journeys.map((row) => `${row.project}/${row.journey}`));
  if (
    input.monitoring.projects.some((row) =>
      row.journeys.some((journey) => !reviewed.has(`${row.catalog_id}/${journey}`)),
    )
  )
    throw new CatalogSyncConflict(
      'Monitoring journeys are missing from the reviewed probe configuration',
    );
  const unlinkedApps = await unlinkedCatalogApps(db, workspace);
  if (unlinkedApps.length > MAX_CATALOG_OUTSIDE_APPS)
    throw new CatalogSyncLimit(OUTSIDE_LIMIT_MESSAGE);
  const unlinked = new Set(unlinkedApps.map((app) => app.app_id));
  const outside = new Set(input.preserve_outside_catalog_app_ids);
  if (
    [...unlinked].some((app) => !outside.has(app)) ||
    [...outside].some((app) => !unlinked.has(app))
  )
    throw new CatalogSyncConflict(UNLINKED_MESSAGE);
  const mapped = (
    await db
      .prepare('SELECT catalog_id, app_id FROM catalog_project_imports WHERE workspace_id = ?')
      .bind(workspace)
      .all<{ catalog_id: string; app_id: string }>()
  ).results;
  const ids = new Map(mapped.map((row) => [row.catalog_id, row.app_id]));
  const projects = await Promise.all(
    input.projects.map(async (project) => {
      const identity = await digest([workspace, project.catalog_id]);
      return {
        ...project,
        app_id: ids.get(project.catalog_id) ?? `app-import-${identity}`,
        environment_id: `env-import-${identity}`,
        is_new: !ids.has(project.catalog_id),
        payload_sha256: await digest(project),
      };
    }),
  );
  const projectionHash = await digest({ projects: input.projects, monitoring: input.monitoring });
  const payload = JSON.stringify(projects);
  const monitoring = JSON.stringify(input.monitoring.projects);
  const statement = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  try {
    const result = await db.batch([
      statement(
        'INSERT INTO workspace_portfolio_sync_guards (workspace_id, projects_json, projection_hash, expected_previous_hash, preserve_outside_catalog_app_ids_json) VALUES (?, ?, ?, ?, ?)',
        workspace,
        payload,
        projectionHash,
        input.expected_previous_hash,
        JSON.stringify(input.preserve_outside_catalog_app_ids),
      ),
      statement(
        `INSERT INTO apps (id, name, created_at)
        SELECT json_extract(value, '$.app_id'), json_extract(value, '$.name'), ? FROM json_each(?) WHERE json_extract(value, '$.is_new') = 1`,
        now,
        payload,
      ),
      statement(
        `INSERT INTO workspace_apps (app_id, workspace_id)
        SELECT json_extract(value, '$.app_id'), ? FROM json_each(?) WHERE json_extract(value, '$.is_new') = 1`,
        workspace,
        payload,
      ),
      statement(
        `INSERT INTO environments (id, app_id, name, created_at)
        SELECT json_extract(value, '$.environment_id'), json_extract(value, '$.app_id'), 'production', ? FROM json_each(?) p
        WHERE NOT EXISTS (SELECT 1 FROM environments e WHERE e.app_id = json_extract(p.value, '$.app_id') AND lower(e.name) = 'production')`,
        now,
        payload,
      ),
      statement(
        `INSERT OR IGNORE INTO installation_status (app_id, environment_id, runtime, first_seen, last_seen)
        SELECT e.app_id, e.id, NULL, NULL, NULL FROM environments e JOIN json_each(?) p ON e.app_id = json_extract(p.value, '$.app_id') WHERE lower(e.name) = 'production'`,
        payload,
      ),
      statement(
        `INSERT INTO catalog_project_imports (workspace_id, catalog_id, catalog_name, app_id, repository, hostname, lifecycle, payload_sha256, created_at)
        SELECT ?, json_extract(value, '$.catalog_id'), json_extract(value, '$.name'), json_extract(value, '$.app_id'), json_extract(value, '$.repository'), json_extract(value, '$.hostname'), 'active', json_extract(value, '$.payload_sha256'), ? FROM json_each(?) WHERE json_extract(value, '$.is_new') = 1`,
        workspace,
        now,
        payload,
      ),
      statement('DELETE FROM workspace_monitoring_projects WHERE workspace_id = ?', workspace),
      statement(
        `INSERT INTO workspace_monitoring_projects (workspace_id, catalog_id, name, scope, reason, journeys_json, updated_at, revision)
        SELECT ?, json_extract(value, '$.catalog_id'), json_extract(value, '$.name'), json_extract(value, '$.scope'), json_extract(value, '$.reason'), json_extract(value, '$.journeys'), ?, ? FROM json_each(?)`,
        workspace,
        now,
        projectionHash,
        monitoring,
      ),
      statement(
        `INSERT INTO workspace_portfolio_snapshots (workspace_id, source, source_catalog_schema_version, projects_json, projection_hash, expected_previous_hash, updated_at)
        VALUES (?, 'saas-maker', 2, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET projects_json = excluded.projects_json, projection_hash = excluded.projection_hash, expected_previous_hash = excluded.expected_previous_hash, updated_at = excluded.updated_at`,
        workspace,
        JSON.stringify(
          projects.map(
            ({ environment_id: _environment, is_new: _new, payload_sha256: _hash, ...row }) => row,
          ),
        ),
        projectionHash,
        input.expected_previous_hash,
        now,
      ),
      statement('DELETE FROM workspace_portfolio_sync_guards WHERE workspace_id = ?', workspace),
    ]);
    if (result.some((row) => !row.success))
      throw new Error('Catalog synchronization transaction failed');
  } catch (error) {
    if (error instanceof Error && error.message.includes('portfolio sync unlinked project'))
      throw new CatalogSyncConflict(UNLINKED_MESSAGE);
    if (
      error instanceof Error &&
      /portfolio sync|UNIQUE constraint failed|catalog import/.test(error.message)
    )
      throw new CatalogSyncConflict(
        'Catalog changed or project ownership conflicts. Reload the preview and retry.',
      );
    throw error;
  }
  return {
    schema_version: 1,
    source: 'saas-maker',
    projection_hash: projectionHash,
    updated_at: now,
    project_count: projects.length,
  };
}

export async function handleCatalogSyncRoute(
  request: Request,
  db: D1DatabaseLike | undefined,
  owner: OwnerIdentity,
) {
  if (new URL(request.url).pathname !== '/v1/catalog/sync') return null;
  if (!catalogSyncOwner(owner))
    return json(403, { error: 'Only the workspace account owner can synchronize its catalog' });
  if (!db) return json(503, { error: 'Catalog storage is unavailable' });
  try {
    if (request.method === 'GET') return json(200, await catalogSyncStatus(db, owner.workspaceId));
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
    const input = CatalogSyncRequestV1.safeParse(await readPublicJson(request, 96 * 1024));
    if (!input.success) return catalogSyncInputError(input.error.issues);
    return json(200, await syncCatalog(db, owner.workspaceId, input.data, Date.now()));
  } catch (error) {
    if (error instanceof CatalogSyncLimit) return json(422, { error: error.message });
    if (error instanceof CatalogSyncConflict) return json(409, { error: error.message });
    if (error instanceof SyntaxError) return json(400, { error: 'Invalid JSON' });
    if (error instanceof Error && error.message === 'payload too large')
      return json(413, { error: 'Catalog projection exceeds 96 KiB' });
    return json(503, { error: 'Catalog synchronization failed; no successful import is claimed' });
  }
}

export async function catalogManualWriteResponse(
  request: Request,
  db: D1DatabaseLike | undefined,
  owner: OwnerIdentity,
) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/apps') return null;
  if (!db || !owner.workspaceId || owner.appId) return null;
  return (await catalogSnapshotStatus(db, owner.workspaceId)).source
    ? json(409, {
        error:
          'This workspace uses the SaaS Maker catalog. Add projects there and synchronize the canonical catalog.',
      })
    : null;
}

function catalogSyncInputError(issues: readonly { path: PropertyKey[] }[]) {
  return issues.some((issue) => issue.path[0] === 'preserve_outside_catalog_app_ids')
    ? json(422, {
        error: `Acknowledge at most ${MAX_CATALOG_OUTSIDE_APPS} unique outside project IDs from the current preview.`,
      })
    : json(400, { error: 'Invalid catalog projection or incomplete monitoring policy' });
}

function catalogSyncOwner(owner: OwnerIdentity): owner is OwnerIdentity & { workspaceId: string } {
  return (
    owner.authKind === 'account' &&
    owner.workspaceRole === 'owner' &&
    Boolean(owner.workspaceId) &&
    !owner.appId
  );
}
