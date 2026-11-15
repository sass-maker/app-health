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
import { CatalogSyncConflict, handleCatalogSyncRoute, syncCatalog } from '../src/catalog-sync.js';
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
  let beforeBatch: (() => void) | undefined;
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
      beforeBatch?.();
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
    beforeBatch: (callback: () => void) => {
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
function seed(f: ReturnType<typeof fixture>, count = 57, mappings = 36) {
  const projects = input().projects;
  for (let index = 0; index < count; index += 1) {
    f.sqlite
      .prepare('INSERT INTO apps(id, name, created_at) VALUES (?, ?, 1)')
      .run(`app-${index}`, `Old ${index}`);
    f.sqlite.prepare('INSERT INTO workspace_apps VALUES (?, ?)').run(`app-${index}`, 'ws');
    f.sqlite
      .prepare('INSERT INTO environments VALUES (?, ?, ?, 1)')
      .run(`env-${index}`, `app-${index}`, 'production');
    if (index < mappings)
      f.sqlite
        .prepare(
          'INSERT INTO catalog_project_imports (workspace_id, catalog_id, catalog_name, app_id, lifecycle, payload_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)',
        )
        .run(
          'ws',
          projects[index]!.catalog_id,
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
    seed(f);
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
