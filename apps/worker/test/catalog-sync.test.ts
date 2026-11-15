import { CatalogImportRequestV1 } from '@app-health/contracts';
import { importCatalogProjects } from '../src/catalog-import.js';
import { handleBrowserOwner } from '../src/browser-routes.js';
import { D1WorkspaceHealth } from '../src/workspace-health.js';
import { currentPortfolioAppIds } from '../src/catalog-inventory.js';
import { URL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogSyncRequestV1, projectCanonicalCatalog } from '@app-health/contracts';
import {
  D1ControlPlane,
  type D1DatabaseLike,
  type D1PreparedStatement,
} from '../src/d1-adapter.js';
import {
  CatalogSyncConflict,
  catalogManualWriteResponse,
  handleCatalogSyncRoute,
  syncCatalog,
} from '../src/catalog-sync.js';
import { handleMonitoringRoute } from '../src/monitoring.js';
import { snapshotCachedAnalytics } from '../src/analytics-cache.js';
import generated from '../../probe/journeys.json';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, directory), 'utf8'));
  sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('owner', 'Owner', 'owner@example.test', 1, 1, 1), ('other', 'Other', 'other@example.test', 1, 1, 1);
    INSERT INTO workspaces VALUES ('ws', 'owner', 'Workspace', 1), ('foreign', 'other', 'Other', 1);`);
  const statements = new WeakMap<D1PreparedStatement, { sql: string; values: unknown[] }>();
  let beforeBatch: (() => void | Promise<void>) | undefined;
  const db: D1DatabaseLike = {
    prepare(sql) {
      const state = { sql, values: [] as unknown[] };
      const statement: D1PreparedStatement = {
        bind(...values) {
          state.values = values;
          return statement;
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...(state.values as SQLInputValue[])) ??
            null) as T | null;
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all(...(state.values as SQLInputValue[])) as T[] };
        },
        async run() {
          const result = sqlite.prepare(sql).run(...(state.values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      statements.set(statement, state);
      return statement;
    },
    async batch(batch) {
      await beforeBatch?.();
      sqlite.exec('BEGIN');
      try {
        const results = batch.map((statement) => {
          const state = statements.get(statement)!;
          if (/^(SELECT|WITH)\b/.test(state.sql.trim()))
            return {
              success: true,
              meta: {},
              results: sqlite.prepare(state.sql).all(...(state.values as SQLInputValue[])),
            };
          const result = sqlite.prepare(state.sql).run(...(state.values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return {
    db,
    sqlite,
    beforeBatch: (callback: () => void | Promise<void>) => {
      beforeBatch = callback;
    },
  };
}
function canonical() {
  const publicIds = [...new Set(generated.journeys.map((row) => row.project))];
  return {
    catalogSchemaVersion: 2,
    ownerNotes: 'PRIVATE_CANARY',
    projects: [...publicIds, 'local-project', 'private-project'].map((id, index) => ({
      id,
      name: `Canonical ${index}`,
      lifecycle: { status: 'retired', portfolioStatus: 'active' },
      classification: {
        kind: index < 30 ? 'product' : index < 33 ? 'platform' : 'experiment',
        futureForm:
          index < 11
            ? 'active-product'
            : index < 16
              ? 'support-tool'
              : index < 32
                ? 'personal-tool'
                : index < 37
                  ? 'finished-experiment'
                  : index < 38
                    ? 'paused-experiment'
                    : 'public-tool',
      },
      deployment: {
        authModel:
          index < 27
            ? 'public-persistent'
            : index < 34
              ? 'local-only'
              : index < 36
                ? 'private-authenticated'
                : index < 39
                  ? 'required-service'
                  : 'public-personalized',
      },
      repositories: { localPath: '/private/canary', url: 'https://github.com/example/project' },
      ownerNotes: 'PRIVATE_CANARY',
      systems: {
        appHealth: {
          browserVisitors: { applicability: 'not-applicable' },
          nativeSessions: 'applicable',
          serverRequests: 'unknown',
        },
        probe:
          index < publicIds.length
            ? {
                journeys: generated.journeys
                  .filter((row) => row.project === id)
                  .map(({ journey }) => ({ journey, url: 'https://ignored.invalid/' })),
              }
            : { scope: index === publicIds.length ? 'local' : 'private', absent: 'PRIVATE_CANARY' },
      },
    })),
  };
}
function input() {
  return projectCanonicalCatalog(canonical(), null);
}
function seed(f: ReturnType<typeof fixture>, count = 57, mappings = 36, unlinked = 0) {
  const projects = input().projects;
  for (let index = 0; index < count; index += 1) {
    f.sqlite
      .prepare('INSERT INTO apps(id, name, created_at) VALUES (?, ?, 1)')
      .run(`app-${index}`, `Old ${index}`);
    f.sqlite.prepare('INSERT INTO workspace_apps VALUES (?, ?)').run(`app-${index}`, 'ws');
    f.sqlite
      .prepare('INSERT INTO environments VALUES (?, ?, ?, 1)')
      .run(`env-${index}`, `app-${index}`, 'production');
    if (index < count - unlinked)
      f.sqlite
        .prepare(
          'INSERT INTO catalog_project_imports (workspace_id, catalog_id, catalog_name, app_id, lifecycle, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)',
        )
        .run(
          'ws',
          index < mappings ? projects[index]!.catalog_id : `legacy-${index}`,
          `Old ${index}`,
          `app-${index}`,
          'primary',
          'a'.repeat(64),
        );
  }
  f.sqlite.exec(
    "INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at) VALUES ('stable-key', 'app-0', 'env-0', 'stable-verifier', 1)",
  );
}

describe('canonical active portfolio synchronization', () => {
  it('selects the explicit active lifecycle and only uploads the allowlist and generic monitoring limits', () => {
    const projected = input();
    expect(projected.projects).toHaveLength(40);
    expect(projected.projects[0]).toMatchObject({
      browser_visitors: 'not_applicable',
      native_sessions: 'applicable',
      server_requests: 'unknown',
    });
    expect(
      projected.projects.filter((row) =>
        ['local-only', 'private-authenticated'].includes(row.auth_model),
      ),
    ).toHaveLength(9);
    expect(projected.projects.filter((row) => row.future_form === 'support-tool')).toHaveLength(5);
    expect(projected.projects.filter((row) => row.future_form === 'personal-tool')).toHaveLength(
      16,
    );
    expect(projected.monitoring.projects.filter((row) => row.scope === 'public')).toHaveLength(38);
    expect(JSON.stringify(projected)).not.toMatch(
      /PRIVATE_CANARY|localPath|ignored.invalid|ownerNotes/,
    );
    const source = canonical();
    source.projects[0]!.lifecycle.portfolioStatus = 'archived';
    expect(projectCanonicalCatalog(source, null).projects).toHaveLength(39);
    expect(() => projectCanonicalCatalog({ ...source, catalogSchemaVersion: 1 }, null)).toThrow();
    expect(() =>
      projectCanonicalCatalog(
        {
          catalogSchemaVersion: 2,
          projects: [{ id: 'ambiguous', name: 'Ambiguous', lifecycle: { status: 'active' } }],
        },
        null,
      ),
    ).toThrow();
    expect(CatalogSyncRequestV1.safeParse({ ...projected, ownerNotes: 'private' }).success).toBe(
      false,
    );
  });

  it('converges 57 owned records to 40 visible projects, preserving IDs, environments, keys and immutable receipts', async () => {
    const f = fixture();
    seed(f, 57, 36, 1);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM catalog_project_imports').get()).toEqual({
      n: 56,
    });
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM current_workspace_catalog').get()).toEqual({
      n: 56,
    });
    await expect(syncCatalog(f.db, 'ws', input(), 8)).rejects.toThrow('existing_app_id');
    await importCatalogProjects(
      f.db,
      'ws',
      CatalogImportRequestV1.parse({
        schema_version: 1,
        projects: [
          {
            catalog_id: 'legacy-56',
            name: 'Explicit legacy mapping',
            lifecycle: 'retired',
            existing_app_id: 'app-56',
          },
        ],
      }),
      9,
    );
    const plane = new D1ControlPlane(f.db, 'ws');
    expect(await plane.listApps()).toHaveLength(57);
    const receipt = f.sqlite
      .prepare('SELECT * FROM catalog_project_imports WHERE app_id = ?')
      .get('app-0');
    const first = await syncCatalog(f.db, 'ws', input(), 10);
    const listed = await plane.listAppsAndEnvironments();
    expect(listed).toHaveLength(40);
    expect(listed[0]?.catalog?.source).toBe('saas-maker');
    const existing = listed.find((row) => row.app.id === 'app-0')!;
    expect(existing.app.name).toBe('Canonical 0');
    expect(existing.environments[0]?.id).toBe('env-0');
    expect(
      f.sqlite.prepare('SELECT * FROM catalog_project_imports WHERE app_id = ?').get('app-0'),
    ).toEqual(receipt);
    expect(f.sqlite.prepare('SELECT verifier_hash FROM keys').get()).toEqual({
      verifier_hash: 'stable-verifier',
    });
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 61 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_monitoring_projects').get(),
    ).toEqual({ n: 40 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_sync_guards').get(),
    ).toEqual({ n: 0 });
    const retry = await syncCatalog(f.db, 'ws', input(), 11);
    expect(retry.projection_hash).toBe(first.projection_hash);
    expect(
      await currentPortfolioAppIds(
        f.db,
        'ws',
        (
          f.sqlite
            .prepare('SELECT app_id FROM workspace_apps WHERE workspace_id = ?')
            .all('ws') as { app_id: string }[]
        ).map((row) => row.app_id),
      ),
    ).toHaveLength(40);
    const health = await new D1WorkspaceHealth(f.db, 'ws').queryWorkspaceHealth(1750000000000);
    expect(health.environments).toHaveLength(40);
    expect(health.environments.find((row) => row.app_id === 'app-0')?.app_name).toBe('Canonical 0');
    expect(await plane.listApps()).toHaveLength(40);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 61 });
    const renamed = input();
    renamed.expected_previous_hash = first.projection_hash;
    renamed.projects[0]!.name = 'Renamed';
    renamed.monitoring.projects[0]!.name = 'Renamed';
    await syncCatalog(f.db, 'ws', renamed, 12);
    expect((await plane.listApps()).find((row) => row.id === 'app-0')?.name).toBe('Renamed');
  });

  it('refuses unlinked manual apps without matching names or creating empty duplicates, then accepts an explicit link', async () => {
    const f = fixture();
    seed(f, 57, 36, 1);
    f.sqlite
      .prepare('UPDATE apps SET name = ? WHERE id = ?')
      .run(input().projects[36]!.name, 'app-56');
    const owner = {
      id: 'owner',
      label: 'Owner',
      authKind: 'account' as const,
      workspaceRole: 'owner' as const,
      workspaceId: 'ws',
    };
    const status = await handleCatalogSyncRoute(
      new Request('https://dashboard.test/v1/catalog/sync'),
      f.db,
      owner,
    );
    expect(await status!.json()).toMatchObject({
      mapped_catalog_ids: expect.arrayContaining([input().projects[0]!.catalog_id]),
      unlinked_apps: [{ app_id: 'app-56', name: input().projects[36]!.name }],
    });
    await expect(syncCatalog(f.db, 'ws', input(), 10)).rejects.toThrow('existing_app_id');
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 57 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_snapshots').get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_monitoring_projects').get(),
    ).toEqual({ n: 0 });
    await importCatalogProjects(
      f.db,
      'ws',
      CatalogImportRequestV1.parse({
        schema_version: 1,
        projects: [
          {
            catalog_id: input().projects[36]!.catalog_id,
            name: input().projects[36]!.name,
            lifecycle: 'active',
            existing_app_id: 'app-56',
          },
        ],
      }),
      11,
    );
    await syncCatalog(f.db, 'ws', input(), 12);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 60 });
    expect(
      (await new D1ControlPlane(f.db, 'ws').listApps()).find((row) => row.id === 'app-56')?.name,
    ).toBe(input().projects[36]!.name);
  });

  it('preserves an explicitly acknowledged outside app, key and history without inventing a catalog identity', async () => {
    const f = fixture();
    seed(f, 57, 36, 1);
    f.sqlite.exec(
      "INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at) VALUES ('outside-key', 'app-56', 'env-56', 'outside-verifier', 1); INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, level) VALUES ('outside-history', 'app-56', 'env-56', 1, 'owner.authored', 'info')",
    );
    const acknowledged = input();
    acknowledged.preserve_outside_catalog_app_ids = ['app-56'];
    const result = await syncCatalog(f.db, 'ws', acknowledged, 10);
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(40);
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM catalog_project_imports WHERE app_id = ?')
        .get('app-56'),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT verifier_hash FROM keys WHERE id = ?').get('outside-key'),
    ).toEqual({ verifier_hash: 'outside-verifier' });
    expect(
      f.sqlite.prepare('SELECT event FROM log_events WHERE log_id = ?').get('outside-history'),
    ).toEqual({ event: 'owner.authored' });
    expect(await new D1ControlPlane(f.db, 'ws').getApp('app-56')).toMatchObject({ id: 'app-56' });
    const snapshot = f.sqlite
      .prepare('SELECT projects_json FROM workspace_portfolio_snapshots')
      .get()!;
    expect(String(snapshot.projects_json)).not.toMatch(/app-56|preserve_outside_catalog_app_ids/);
    expect((await syncCatalog(f.db, 'ws', acknowledged, 11)).projection_hash).toBe(
      result.projection_hash,
    );
    await expect(syncCatalog(f.db, 'ws', input(), 12)).rejects.toThrow('explicitly acknowledge');
  });

  it('links a preserved outside app after synchronization without changing the roster until the next canonical sync', async () => {
    const f = fixture();
    seed(f, 57, 36, 1);
    f.sqlite.exec(
      "INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at) VALUES ('outside-key', 'app-56', 'env-56', 'outside-verifier', 1)",
    );
    const initial = input();
    initial.preserve_outside_catalog_app_ids = ['app-56'];
    const first = await syncCatalog(f.db, 'ws', initial, 10);
    const link = CatalogImportRequestV1.parse({
      schema_version: 1,
      projects: [
        {
          catalog_id: 'outside-service',
          name: 'Outside service joins',
          lifecycle: 'active',
          existing_app_id: 'app-56',
        },
      ],
    });
    await importCatalogProjects(f.db, 'ws', link, 11, true);
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(40);
    expect(
      (await new D1ControlPlane(f.db, 'ws').listApps()).some((app) => app.id === 'app-56'),
    ).toBe(false);
    await expect(importCatalogProjects(f.db, 'ws', link, 12, true)).rejects.toThrow(
      'already linked',
    );
    const generic = CatalogImportRequestV1.parse({
      schema_version: 1,
      projects: [{ catalog_id: 'manual-duplicate', name: 'Manual duplicate', lifecycle: 'active' }],
    });
    await expect(importCatalogProjects(f.db, 'ws', generic, 12, true)).rejects.toThrow(
      'existing_app_id',
    );
    const next = input();
    next.expected_previous_hash = first.projection_hash;
    next.projects[39] = {
      ...next.projects[39]!,
      catalog_id: 'outside-service',
      name: 'Outside service joins',
    };
    next.monitoring.projects[39] = {
      catalog_id: 'outside-service',
      name: 'Outside service joins',
      scope: 'private',
      reason: 'Private service.',
      journeys: [],
    };
    await syncCatalog(f.db, 'ws', next, 13);
    expect(
      (await new D1ControlPlane(f.db, 'ws').listApps()).find((app) => app.id === 'app-56')?.name,
    ).toBe('Outside service joins');
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(40);
    expect(
      f.sqlite.prepare('SELECT verifier_hash FROM keys WHERE id = ?').get('outside-key'),
    ).toEqual({ verifier_hash: 'outside-verifier' });
  });

  it('rejects outside acknowledgements for mapped, foreign, unknown or archived apps and closes ownership races', async () => {
    for (const invalid of ['app-0', 'unknown', 'foreign-app', 'archived-app']) {
      const f = fixture();
      seed(f, 57, 36, 1);
      f.sqlite.exec(
        "INSERT INTO apps (id, name, created_at, archived_at) VALUES ('foreign-app', 'Foreign', 1, NULL), ('archived-app', 'Archived', 1, 2); INSERT INTO workspace_apps VALUES ('foreign-app', 'foreign'), ('archived-app', 'ws')",
      );
      const bad = input();
      bad.preserve_outside_catalog_app_ids = ['app-56', invalid];
      await expect(syncCatalog(f.db, 'ws', bad, 10)).rejects.toThrow('existing_app_id');
      expect(
        f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_snapshots').get(),
      ).toEqual({ n: 0 });
    }
    const f = fixture();
    seed(f, 57, 36, 1);
    const raced = input();
    raced.preserve_outside_catalog_app_ids = ['app-56'];
    f.beforeBatch(() =>
      f.sqlite.exec("UPDATE workspace_apps SET workspace_id = 'foreign' WHERE app_id = 'app-56'"),
    );
    await expect(syncCatalog(f.db, 'ws', raced, 10)).rejects.toThrow('existing_app_id');
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 57 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_snapshots').get(),
    ).toEqual({ n: 0 });
    const duplicate = input();
    duplicate.preserve_outside_catalog_app_ids = ['app-56', 'app-56'];
    expect(CatalogSyncRequestV1.safeParse(duplicate).success).toBe(false);
  });

  it('rejects an unlinked app appearing after resolution inside the SQL transaction guard', async () => {
    const f = fixture();
    seed(f);
    f.beforeBatch(() =>
      f.sqlite.exec(
        "INSERT INTO apps (id, name, created_at) VALUES ('late-manual', 'Late manual project', 1); INSERT INTO workspace_apps VALUES ('late-manual', 'ws')",
      ),
    );
    await expect(syncCatalog(f.db, 'ws', input(), 10)).rejects.toThrow('existing_app_id');
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 58 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_snapshots').get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_monitoring_projects').get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_sync_guards').get(),
    ).toEqual({ n: 0 });
  });

  it('rejects repeated existing app links before any V1 SQL write', async () => {
    const f = fixture();
    seed(f);
    const one = CatalogImportRequestV1.parse({
      schema_version: 1,
      projects: [
        {
          catalog_id: 'unique-catalog-id',
          name: 'One',
          lifecycle: 'active',
          existing_app_id: 'app-56',
        },
      ],
    });
    one.projects.push({ ...one.projects[0]!, catalog_id: 'another-catalog-id' });
    await expect(importCatalogProjects(f.db, 'ws', one, 10)).rejects.toThrow(
      'Duplicate existing_app_id',
    );
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 57 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_catalog_import_guards').get(),
    ).toEqual({ n: 0 });
  });

  it('guards V1 creation atomically when a snapshot commits after its preflight', async () => {
    const f = fixture();
    seed(f);
    const counts = () =>
      f.sqlite
        .prepare(
          `SELECT (SELECT count(*) FROM apps) AS apps, (SELECT count(*) FROM environments) AS environments, (SELECT count(*) FROM keys) AS keys, (SELECT count(*) FROM catalog_project_imports) AS links`,
        )
        .get();
    let committed: ReturnType<typeof counts>;
    f.beforeBatch(async () => {
      f.beforeBatch(() => {});
      await syncCatalog(f.db, 'ws', input(), 20);
      committed = counts();
    });
    const stale = CatalogImportRequestV1.parse({
      schema_version: 1,
      projects: [{ catalog_id: 'stale-manual', name: 'Stale manual', lifecycle: 'active' }],
    });
    await expect(importCatalogProjects(f.db, 'ws', stale, 10, false)).rejects.toThrow(
      'existing_app_id',
    );
    expect(counts()).toEqual(committed!);
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM catalog_project_imports WHERE catalog_id = 'stale-manual'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_catalog_import_guards').get(),
    ).toEqual({ n: 0 });
  });

  it('returns actionable capacity errors for owner previews and oversized acknowledgements', async () => {
    const f = fixture();
    seed(f, 61, 0, 61);
    const owner = {
      id: 'owner',
      label: 'Owner',
      authKind: 'account' as const,
      workspaceRole: 'owner' as const,
      workspaceId: 'ws',
    };
    const get = await handleCatalogSyncRoute(
      new Request('https://dashboard.test/v1/catalog/sync'),
      f.db,
      owner,
    );
    expect(get?.status).toBe(422);
    expect(await get!.json()).toMatchObject({
      error: expect.stringContaining('at most 60 outside projects'),
    });
    const oversized = input();
    oversized.preserve_outside_catalog_app_ids = Array.from(
      { length: 61 },
      (_, index) => `app-${index}`,
    );
    const post = await handleCatalogSyncRoute(
      new Request('https://dashboard.test/v1/catalog/sync', {
        method: 'POST',
        body: JSON.stringify(oversized),
      }),
      f.db,
      owner,
    );
    expect(post?.status).toBe(422);
    expect(await post!.json()).toMatchObject({
      error: expect.stringContaining('at most 60 unique'),
    });
  });

  it('preserves unsynchronized manual flows beyond the catalog preview capacity', async () => {
    const f = fixture();
    seed(f, 61, 0, 61);
    const owner = {
      id: 'owner',
      label: 'Owner',
      authKind: 'account' as const,
      workspaceRole: 'owner' as const,
      workspaceId: 'ws',
    };
    expect(
      await catalogManualWriteResponse(
        new Request('https://dashboard.test/v1/apps', { method: 'POST' }),
        f.db,
        owner,
      ),
    ).toBeNull();
    const created = await new D1ControlPlane(f.db, 'ws').createAppEnvironmentKey(
      'Manual allowed',
      'production',
      10,
    );
    expect(created.rawKey).toBeTruthy();
    await importCatalogProjects(
      f.db,
      'ws',
      CatalogImportRequestV1.parse({
        schema_version: 1,
        projects: [{ catalog_id: 'legacy-extra', name: 'Legacy extra', lifecycle: 'active' }],
      }),
      10,
    );
    const policy = await handleMonitoringRoute(
      new Request('https://dashboard.test/v1/workspace/monitoring/policy', {
        method: 'PUT',
        body: JSON.stringify({
          schema_version: 1,
          projects: [
            {
              catalog_id: 'legacy-extra',
              name: 'Legacy extra',
              scope: 'local',
              reason: 'Local service only.',
              journeys: [],
            },
          ],
        }),
      }),
      f.db,
      owner,
    );
    expect(policy?.status).toBe(200);
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(63);
    const preview = await handleCatalogSyncRoute(
      new Request('https://dashboard.test/v1/catalog/sync'),
      f.db,
      owner,
    );
    expect(preview?.status).toBe(422);
    expect(await preview!.json()).toMatchObject({
      error: expect.stringContaining('at most 60 outside projects'),
    });
  });

  it('rejects stale updates and rolls back all metadata and policy changes', async () => {
    const f = fixture();
    seed(f);
    await syncCatalog(f.db, 'ws', input(), 10);
    const next = input();
    next.projects[0]!.name = 'Stale';
    next.monitoring.projects[0]!.name = 'Stale';
    await expect(syncCatalog(f.db, 'ws', next, 20)).rejects.toBeInstanceOf(CatalogSyncConflict);
    expect(
      f.sqlite
        .prepare('SELECT catalog_name FROM current_workspace_catalog WHERE app_id = ?')
        .get('app-0'),
    ).toEqual({ catalog_name: 'Canonical 0' });
    expect(
      f.sqlite.prepare('SELECT updated_at FROM workspace_monitoring_projects LIMIT 1').get(),
    ).toEqual({ updated_at: 10 });
  });

  it('rejects archived, foreign and legacy claims before creating missing projects', async () => {
    for (const conflict of ['archive', 'foreign', 'legacy']) {
      const f = fixture();
      seed(f);
      if (conflict === 'archive')
        f.sqlite.exec("UPDATE apps SET archived_at = 1 WHERE id = 'app-35'");
      if (conflict === 'foreign')
        f.sqlite.exec("UPDATE workspace_apps SET workspace_id = 'foreign' WHERE app_id = 'app-35'");
      if (conflict === 'legacy') {
        await syncCatalog(f.db, 'ws', input(), 10);
        f.sqlite.exec(
          "DELETE FROM workspace_portfolio_snapshots; DELETE FROM catalog_project_imports WHERE catalog_id = (SELECT catalog_id FROM catalog_project_imports WHERE app_id LIKE 'app-import-%' LIMIT 1)",
        );
      }
      const before = f.sqlite.prepare('SELECT count(*) AS n FROM apps').get();
      await expect(syncCatalog(f.db, 'ws', input(), 20)).rejects.toBeInstanceOf(
        CatalogSyncConflict,
      );
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual(before);
      expect(
        f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_snapshots').get(),
      ).toEqual({ n: 0 });
    }
  });

  it('revalidates ownership in the transaction after resolution and on identical retries', async () => {
    const f = fixture();
    seed(f);
    f.beforeBatch(() =>
      f.sqlite.exec("UPDATE workspace_apps SET workspace_id = 'foreign' WHERE app_id = 'app-35'"),
    );
    await expect(syncCatalog(f.db, 'ws', input(), 10)).rejects.toBeInstanceOf(CatalogSyncConflict);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 57 });
    f.beforeBatch(() => {});
    f.sqlite.exec("UPDATE workspace_apps SET workspace_id = 'ws' WHERE app_id = 'app-35'");
    await syncCatalog(f.db, 'ws', input(), 10);
    f.sqlite.exec("UPDATE workspace_apps SET workspace_id = 'foreign' WHERE app_id = 'app-35'");
    await expect(syncCatalog(f.db, 'ws', input(), 11)).rejects.toBeInstanceOf(CatalogSyncConflict);
  });

  it('rolls back all creations if ownership changes after the initial transaction guard', async () => {
    const f = fixture();
    seed(f);
    f.sqlite.exec(`CREATE TRIGGER late_conflict AFTER INSERT ON apps WHEN NEW.id LIKE 'app-import-%'
      BEGIN UPDATE workspace_apps SET workspace_id = 'foreign' WHERE app_id = 'app-35'; END;`);
    await expect(syncCatalog(f.db, 'ws', input(), 10)).rejects.toBeInstanceOf(CatalogSyncConflict);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({ n: 57 });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_monitoring_projects').get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare("SELECT workspace_id FROM workspace_apps WHERE app_id = 'app-35'").get(),
    ).toEqual({ workspace_id: 'ws' });
  });

  it('fences cached and in-flight report cohorts with the durable snapshot revision', async () => {
    const f = fixture();
    seed(f);
    const cache = new Map<string, Response>();
    const adapter = {
      match: async (key: Request) => cache.get(key.url)?.clone(),
      put: async (key: Request, value: Response) => {
        cache.set(key.url, value);
      },
    };
    let finishOld!: (value: number) => void;
    const old = snapshotCachedAnalytics(
      f.db,
      'owner',
      'ws',
      'cohort',
      () =>
        new Promise<number>((resolve) => {
          finishOld = resolve;
        }),
      adapter,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await syncCatalog(f.db, 'ws', input(), 10);
    const current = () =>
      snapshotCachedAnalytics(
        f.db,
        'owner',
        'ws',
        'cohort',
        async () => (await new D1ControlPlane(f.db, 'ws').listApps()).length,
        adapter,
      );
    expect(await current()).toBe(40);
    finishOld(57);
    expect(await old).toBe(57);
    expect(await current()).toBe(40);
  });

  it('uses the current roster for default browser reports while preserving explicit owned historical reads', async () => {
    const f = fixture();
    seed(f);
    await syncCatalog(f.db, 'ws', input(), 10);
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        queries.push(String(init?.body));
        return Response.json({ data: [] });
      }),
    );
    const env = {
      DB: f.db,
      BROWSER_ANALYTICS: { writeDataPoint() {} },
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic-query',
    };
    const owner = { id: 'owner', label: 'Owner', workspaceId: 'ws', appIds: ['app-0', 'app-56'] };
    expect(
      (
        await handleBrowserOwner(
          new Request('https://dashboard.test/v1/analytics/report?range=24h'),
          env,
          owner,
          false,
        )
      )?.status,
    ).toBe(200);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join(' ')).toContain('app-0');
    expect(queries.join(' ')).not.toContain('app-56');
    queries.length = 0;
    expect(
      (
        await handleBrowserOwner(
          new Request(
            'https://dashboard.test/v1/analytics/report?range=24h&app_id=app-56&environment_id=env-56',
          ),
          env,
          owner,
          false,
        )
      )?.status,
    ).toBe(200);
    expect(queries.join(' ')).toContain('app-56');
  });

  it('requires an owner account, bounds input and rejects unreviewed public journeys', async () => {
    const f = fixture();
    const owner = {
      id: 'owner',
      label: 'Owner',
      authKind: 'account' as const,
      workspaceRole: 'owner' as const,
      workspaceId: 'ws',
    };
    const request = (body = input()) =>
      new Request('https://dashboard.test/v1/catalog/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (const denied of [
      { ...owner, authKind: 'api-token' as const },
      { ...owner, workspaceRole: 'editor' as const },
      { ...owner, workspaceRole: 'viewer' as const },
      { ...owner, appId: 'app' },
    ])
      expect((await handleCatalogSyncRoute(request(), f.db, denied))?.status).toBe(403);
    const invalid = input();
    invalid.monitoring.projects[0]!.journeys = ['unreviewed'];
    expect((await handleCatalogSyncRoute(request(invalid), f.db, owner))?.status).toBe(409);
    expect(
      (
        await handleCatalogSyncRoute(
          new Request('https://dashboard.test/v1/catalog/sync', {
            method: 'POST',
            body: 'x'.repeat(100_000),
          }),
          f.db,
          owner,
        )
      )?.status,
    ).toBe(413);
    expect((await handleCatalogSyncRoute(request(), f.db, owner))?.status).toBe(200);
  });
});

it.runIf(Boolean(process.env.APP_HEALTH_OWNER_CATALOG))(
  'projects the owner canonical file locally without publishing private fields',
  () => {
    const projected = projectCanonicalCatalog(
      JSON.parse(readFileSync(process.env.APP_HEALTH_OWNER_CATALOG!, 'utf8')),
      null,
    );
    expect(projected.projects).toHaveLength(40);
    expect(
      projected.projects.filter((row) =>
        ['local-only', 'private-authenticated'].includes(row.auth_model),
      ),
    ).toHaveLength(9);
    expect(projected.projects.filter((row) => row.future_form === 'support-tool')).toHaveLength(5);
    expect(projected.projects.filter((row) => row.future_form === 'personal-tool')).toHaveLength(
      16,
    );
    expect(projected.monitoring.projects.filter((row) => row.scope === 'public')).toHaveLength(38);
    expect(projected.monitoring.projects.reduce((sum, row) => sum + row.journeys.length, 0)).toBe(
      44,
    );
    expect(
      projected.projects.find((row) => row.catalog_id === 'site-health')?.browser_visitors,
    ).toBe('not_applicable');
  },
);
