import {
  probeDefinitionRevision,
  projectCanonicalCatalogWithRevisions,
  CatalogImportRequestV1,
} from '@app-health/contracts';
import { importCatalogProjects } from '../src/catalog-import.js';
import { handleBrowserOwner } from '../src/browser-routes.js';
import { D1WorkspaceHealth } from '../src/workspace-health.js';
import { currentPortfolioAnalyticsSnapshot } from '../src/catalog-inventory.js';
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
import { handleMonitoringRoute, readMonitoringReport } from '../src/monitoring.js';
import { runScheduledMonitoring } from '../src/monitoring-scheduled.js';
import { snapshotCachedAnalytics } from '../src/analytics-cache.js';
import generated from '../../probe/journeys.json';
import {
  handleCatalogPublisher as handleCatalogPublisherRuntime,
  handleCatalogPublisherOwner,
} from '../src/catalog-publishers.js';

const canonicalPublicProjectIds = [...new Set(generated.journeys.map((row) => row.project))];
const canonicalProjectCount = canonicalPublicProjectIds.length + 2;

const enrollmentTestSecret = 'synthetic-enrollment-hmac-secret';
const handleCatalogPublisher = (
  request: Request,
  db: Parameters<typeof handleCatalogPublisherRuntime>[1],
  now = Date.now(),
) => handleCatalogPublisherRuntime(request, db, now, enrollmentTestSecret);

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
  const publicIds = canonicalPublicProjectIds;
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

const publisherOwner = {
  id: 'owner',
  label: 'Owner',
  authKind: 'account' as const,
  workspaceRole: 'owner' as const,
  workspaceId: 'ws',
};
function publisherRequest(path: string, body?: unknown, secret?: string) {
  return new Request(`https://dashboard.example.com/v1/catalog/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'cf-connecting-ip': '192.0.2.1',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(completePublisherProjection(body)),
  });
}
function completePublisherProjection(body: unknown) {
  const value = body as {
    monitoring?: {
      projects: Array<{ journeys: string[]; journey_revisions?: Record<string, string> }>;
    };
  };
  if (!value?.monitoring) return body;
  return {
    ...value,
    monitoring: {
      ...value.monitoring,
      projects: value.monitoring.projects.map((row) => ({
        ...row,
        journey_revisions:
          row.journey_revisions ??
          Object.fromEntries(row.journeys.map((id) => [id, 'a'.repeat(64)])),
      })),
    },
  };
}
function publisherOwnerRequest(path: string, body?: unknown) {
  const request = publisherRequest(`publishers${path}`, body);
  if (body !== undefined) request.headers.set('origin', 'https://dashboard.example.com');
  return request;
}
async function enrolledPublisher(f: ReturnType<typeof fixture>) {
  const response = await handleCatalogPublisher(
    publisherRequest('publisher/enroll', { label: 'Test Mac' }),
    f.db,
    1000,
  );
  expect(response?.status).toBe(201);
  return (await response!.json()) as {
    publisher_id: string;
    code: string;
    secret: string;
    expires_at: number;
  };
}
async function approvePublisher(
  f: ReturnType<typeof fixture>,
  code: string,
  outside: string[] = [],
) {
  return handleCatalogPublisherOwner(
    publisherOwnerRequest('/approve', {
      code,
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: outside,
    }),
    f.db,
    publisherOwner,
    2000,
  );
}

describe('automatic catalog publisher authority', () => {
  it('adds new metadata automatically while unreviewed checks remain missing and cannot run or inherit receipts', async () => {
    const f = fixture();
    seed(f, 40, 40);
    const baselineInput = input();
    baselineInput.monitoring.projects = baselineInput.monitoring.projects.map((row) => ({
      ...row,
      scope: 'local',
      reason: 'Local fixture.',
      journeys: [],
    }));
    const baseline = await syncCatalog(f.db, 'ws', baselineInput, 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    const next = { ...baselineInput, expected_previous_hash: baseline.projection_hash };
    next.projects = [
      ...next.projects,
      { ...next.projects[0]!, catalog_id: 'new-product', name: 'New product' },
    ];
    next.monitoring = {
      ...next.monitoring,
      projects: [
        ...next.monitoring.projects,
        {
          catalog_id: 'new-product',
          name: 'New product',
          scope: 'public',
          reason: null,
          journeys: ['new-home'],
        },
      ],
    };
    expect(
      (
        await handleCatalogSyncRoute(
          new Request('https://dashboard.example.com/v1/catalog/sync', {
            method: 'POST',
            body: JSON.stringify(next),
          }),
          f.db,
          publisherOwner,
        )
      )?.status,
    ).toBe(409);
    const response = await handleCatalogPublisher(
      publisherRequest('publisher', next, paired.secret),
      f.db,
      3000,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      project_count: baselineInput.projects.length + 1,
    });
    f.sqlite
      .prepare(
        "INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, level, props, source) VALUES ('unreviewed-receipt', 'app-0', 'env-0', 3000, 'probe.result', 'debug', ?, 'server')",
      )
      .run(
        JSON.stringify({
          project: 'new-product',
          journey: 'new-home',
          location: 'cloudflare',
          interval_seconds: 3600,
          status: 'healthy',
          total_ms: 1,
        }),
      );
    const report = await readMonitoringReport(f.db, 'ws', 4000, undefined, {
      appId: 'app-0',
      environmentId: 'env-0',
    });
    expect(report.projects.find((row) => row.catalog_id === 'new-product')).toMatchObject({
      state: 'missing',
      reason: expect.stringContaining('Awaiting reviewed check configuration'),
      checks: [{ journey: 'new-home', freshness: 'missing', health: null, observations: [] }],
    });
    const source = await new D1ControlPlane(f.db).createKey('app-0', 'env-0', 4000);
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    await runScheduledMonitoring(
      {
        DB: f.db,
        APP_HEALTH_SELF_BACKEND_KEY: source.rawKey,
        APP_HEALTH_SELF_APP_ID: 'app-0',
        APP_HEALTH_SELF_ENVIRONMENT_ID: 'env-0',
      },
      fetcher,
      4000,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('imports changed definitions while fencing old fetches and old healthy receipts until reviewed configuration matches', async () => {
    const f = fixture();
    seed(f, 40, 40);
    const source = canonical();
    for (const row of source.projects)
      if (row.systems.probe.journeys)
        row.systems.probe.journeys = generated.journeys.filter((check) => check.project === row.id);
    const baselineInput = await projectCanonicalCatalogWithRevisions(source, null);
    await syncCatalog(f.db, 'ws', baselineInput, 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    const target = source.projects.find((row) => row.systems.probe.journeys?.length)!;
    const definition = target.systems.probe.journeys![0]!;
    const original = structuredClone(definition);
    const revision = await probeDefinitionRevision(original);
    f.sqlite
      .prepare(
        "INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, level, props, source) VALUES ('old-healthy', 'app-0', 'env-0', 3000, 'probe.result', 'debug', ?, 'server')",
      )
      .run(
        JSON.stringify({
          project: target.id,
          journey: definition.journey,
          revision,
          location: 'cloudflare',
          interval_seconds: 3600,
          status: 'healthy',
          total_ms: 1,
        }),
      );
    const healthyReport = await readMonitoringReport(f.db, 'ws', 3500, undefined, {
      appId: 'app-0',
      environmentId: 'env-0',
    });
    expect(
      healthyReport.projects.find((row) => row.catalog_id === target.id)!.checks[0]!.health,
    ).toBe('healthy');
    for (const change of [
      { url: 'https://unreviewed.invalid/' },
      { expect: { body_includes: ['changed marker'] } },
    ]) {
      Object.assign(definition, original, change);
      const next = await projectCanonicalCatalogWithRevisions(
        source,
        (
          f.sqlite.prepare('SELECT projection_hash FROM workspace_portfolio_snapshots').get() as {
            projection_hash: string;
          }
        ).projection_hash,
      );
      target.name = 'Updated product';
      const response = await handleCatalogPublisher(
        publisherRequest('publisher', next, paired.secret),
        f.db,
        4000,
      );
      expect(response?.status).toBe(200);
      const report = await readMonitoringReport(f.db, 'ws', 4500, undefined, {
        appId: 'app-0',
        environmentId: 'env-0',
      });
      expect(report.projects.find((row) => row.catalog_id === target.id)!.checks[0]).toMatchObject({
        freshness: 'missing',
        health: null,
        observations: [],
      });
      const key = await new D1ControlPlane(f.db).createKey('app-0', 'env-0', 4500);
      const fetcher = vi.fn<typeof fetch>(async () => new Response('OK'));
      await runScheduledMonitoring(
        {
          DB: f.db,
          APP_HEALTH_SELF_BACKEND_KEY: key.rawKey,
          APP_HEALTH_SELF_APP_ID: 'app-0',
          APP_HEALTH_SELF_ENVIRONMENT_ID: 'env-0',
        },
        fetcher,
        5000,
      );
      expect(
        fetcher.mock.calls.some(
          ([url]) => String(url) === original.url || String(url).includes('unreviewed.invalid'),
        ),
      ).toBe(false);
      f.sqlite.prepare('DELETE FROM workspace_monitoring_runs').run();
    }
    Object.assign(definition, original);
    const fixed = await projectCanonicalCatalogWithRevisions(
      source,
      (
        f.sqlite.prepare('SELECT projection_hash FROM workspace_portfolio_snapshots').get() as {
          projection_hash: string;
        }
      ).projection_hash,
    );
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', fixed, paired.secret),
          f.db,
          6000,
        )
      )?.status,
    ).toBe(200);
    const fixedReport = await readMonitoringReport(f.db, 'ws', 6500, undefined, {
      appId: 'app-0',
      environmentId: 'env-0',
    });
    expect(
      fixedReport.projects.find((row) => row.catalog_id === target.id)!.checks[0]!.health,
    ).toBe('healthy');
  });
  it('keeps an older active publisher visible ahead of ten recently revoked connections', async () => {
    const f = fixture();
    seed(f, 40, 40);
    await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    for (let index = 0; index < 10; index += 1) {
      f.sqlite
        .prepare(
          'INSERT INTO catalog_publishers (id, verifier_hash, pairing_code, label, created_at, expires_at, workspace_id, approved_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          crypto.randomUUID(),
          `revoked-hash-${index}`,
          index.toString(16).padStart(12, '0').toUpperCase(),
          `Revoked ${index}`,
          3000,
          4000,
          'ws',
          3000 + index,
          4000 + index,
        );
    }
    const response = await handleCatalogPublisherOwner(
      publisherOwnerRequest(''),
      f.db,
      publisherOwner,
    );
    const body = (await response!.json()) as {
      publishers: Array<{ id: string; revoked_at: number | null }>;
    };
    expect(body.publishers).toHaveLength(10);
    expect(body.publishers[0]).toMatchObject({ id: paired.publisher_id, revoked_at: null });
  });
  it('requires complete server-side revisions even when a publisher omits the client guard', async () => {
    const f = fixture();
    seed(f, 39, 39);
    await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    const previous = f.sqlite
      .prepare('SELECT projection_hash FROM workspace_portfolio_snapshots')
      .get();
    const raw = publisherRequest('publisher', undefined, paired.secret);
    const request = new Request(raw.url, {
      method: 'POST',
      headers: raw.headers,
      body: JSON.stringify(input()),
    });
    expect((await handleCatalogPublisher(request, f.db, 3000))?.status).toBe(400);
    expect(
      f.sqlite.prepare('SELECT projection_hash FROM workspace_portfolio_snapshots').get(),
    ).toEqual(previous);
  });
  it('bounds pending enrollment per normalized caller and bucket and rejects unknown callers', async () => {
    const f = fixture();
    const request = (ip?: string) => {
      const value = publisherRequest('publisher/enroll', { label: 'Mac' });
      if (ip === undefined) {
        value.headers.delete('cf-connecting-ip');
        value.headers.set('x-forwarded-for', '192.0.2.1');
      } else value.headers.set('cf-connecting-ip', ip);
      return value;
    };
    for (const ip of [
      undefined,
      'not-an-address',
      '256.0.0.1',
      '2001:::bad',
      '192.0.2.1, 192.0.2.2',
    ])
      expect((await handleCatalogPublisher(request(ip), f.db, 1000))?.status).toBe(403);
    for (let i = 0; i < 4; i += 1)
      expect((await handleCatalogPublisher(request('192.000.2.1'), f.db, 1000))?.status).toBe(201);
    expect((await handleCatalogPublisher(request('192.0.2.1'), f.db, 1000))?.status).toBe(429);
    expect((await handleCatalogPublisher(request('192.0.2.2'), f.db, 1000))?.status).toBe(201);
    expect((await handleCatalogPublisher(request('2001:db8::1'), f.db, 1000))?.status).toBe(201);
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT enrollment_key FROM catalog_publishers').all()),
    ).not.toMatch(/192\.|2001:/);
    expect((await handleCatalogPublisher(request('192.0.2.1'), f.db, 900000))?.status).toBe(201);
    expect((await handleCatalogPublisher(request('192.0.2.1'), f.db, 1800001))?.status).toBe(201);
    expect(
      (f.sqlite.prepare('SELECT count(*) AS n FROM catalog_publishers').get() as { n: number }).n,
    ).toBe(1);
  });
  it('recovers reviewed outside decisions with owner consent while fencing revocation and roster races', async () => {
    const f = fixture();
    seed(f, 39, 39);
    const baseline = await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    expect(f.sqlite.prepare('SELECT enrollment_key FROM catalog_publishers').get()).toEqual({
      enrollment_key: null,
    });
    f.sqlite.exec(
      "INSERT INTO apps (id,name,created_at) VALUES ('outside-new','Outside',1); INSERT INTO workspace_apps VALUES ('outside-new','ws');",
    );
    const next = { ...input(), expected_previous_hash: baseline.projection_hash };
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 3000))
        ?.status,
    ).toBe(409);
    const body = {
      publisher_id: paired.publisher_id,
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: ['outside-new'],
    };
    for (const owner of [
      { ...publisherOwner, workspaceId: 'foreign' },
      { ...publisherOwner, authKind: 'api-token' as const },
      { ...publisherOwner, workspaceRole: 'editor' as const },
    ])
      expect(
        (
          await handleCatalogPublisherOwner(
            publisherOwnerRequest('/review', body),
            f.db,
            owner,
            3000,
          )
        )?.status,
      ).not.toBe(200);
    const cross = publisherOwnerRequest('/review', body);
    cross.headers.set('origin', 'https://other.test');
    expect((await handleCatalogPublisherOwner(cross, f.db, publisherOwner))?.status).toBe(403);
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/review', { ...body, preserve_outside_catalog_app_ids: [] }),
          f.db,
          publisherOwner,
        )
      )?.status,
    ).toBe(409);
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/review', body),
          f.db,
          publisherOwner,
          4000,
        )
      )?.status,
    ).toBe(200);
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 5000))
        ?.status,
    ).toBe(200);
    f.sqlite.prepare("UPDATE apps SET archived_at = 5500 WHERE id = 'outside-new'").run();
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 5600))
        ?.status,
    ).toBe(409);
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/review', { ...body, preserve_outside_catalog_app_ids: [] }),
          f.db,
          publisherOwner,
          5700,
        )
      )?.status,
    ).toBe(200);
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 5800))
        ?.status,
    ).toBe(200);
    f.sqlite.prepare('UPDATE catalog_publishers SET revoked_at = 6000').run();
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/review', body),
          f.db,
          publisherOwner,
          7000,
        )
      )?.status,
    ).toBe(409);
  });
  it.each(['revoke', 'new-outside'] as const)(
    'fences a concurrent %s inside the outside-review SQL statement',
    async (race) => {
      const f = fixture();
      seed(f, 39, 39);
      await syncCatalog(f.db, 'ws', input(), 1000);
      const paired = await enrolledPublisher(f);
      await approvePublisher(f, paired.code);
      const prepare = f.db.prepare.bind(f.db);
      f.db.prepare = (sql) => {
        const statement = prepare(sql);
        if (sql.includes('UPDATE catalog_publishers SET outside_app_ids_json')) {
          const first = statement.first.bind(statement);
          statement.first = async <T>() => {
            if (race === 'revoke')
              f.sqlite.prepare('UPDATE catalog_publishers SET revoked_at = 3000').run();
            else
              f.sqlite.exec(
                "INSERT INTO apps (id,name,created_at) VALUES ('race-outside','Outside',1); INSERT INTO workspace_apps VALUES ('race-outside','ws');",
              );
            return first<T>();
          };
        }
        return statement;
      };
      const response = await handleCatalogPublisherOwner(
        publisherOwnerRequest('/review', {
          publisher_id: paired.publisher_id,
          allow_automatic_updates: true,
          preserve_outside_catalog_app_ids: [],
        }),
        f.db,
        publisherOwner,
        4000,
      );
      expect(response?.status).toBe(409);
      expect(f.sqlite.prepare('SELECT outside_app_ids_json FROM catalog_publishers').get()).toEqual(
        { outside_app_ids_json: '[]' },
      );
    },
  );
  it('keeps the revision requirement monotonic through owner syncs, private-only policies and a concurrent upgrade', async () => {
    const f = fixture();
    seed(f, 39, 39);
    const baseline = await syncCatalog(f.db, 'ws', input(), 1000);
    expect(f.sqlite.prepare('SELECT * FROM workspace_catalog_revision_fences').all()).toHaveLength(
      0,
    );
    const versioned = CatalogSyncRequestV1.parse(
      completePublisherProjection({ ...input(), expected_previous_hash: baseline.projection_hash }),
    );
    const upgraded = await syncCatalog(f.db, 'ws', versioned, 2000);
    const legacy = { ...input(), expected_previous_hash: upgraded.projection_hash };
    const ownerSync = (body: unknown) =>
      handleCatalogSyncRoute(
        new Request('https://dashboard.example.com/v1/catalog/sync', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
        f.db,
        publisherOwner,
      );
    expect((await ownerSync(legacy))?.status).toBe(400);
    const localOnly = {
      ...legacy,
      monitoring: {
        schema_version: 1 as const,
        projects: legacy.monitoring.projects.map((row) => ({
          ...row,
          scope: 'local' as const,
          reason: 'Local fixture.',
          journeys: [],
        })),
      },
    };
    const local = await syncCatalog(f.db, 'ws', localOnly, 3000);
    expect(
      (await ownerSync({ ...input(), expected_previous_hash: local.projection_hash }))?.status,
    ).toBe(400);
    expect(
      f.sqlite.prepare('SELECT workspace_id FROM workspace_catalog_revision_fences').all(),
    ).toEqual([{ workspace_id: 'ws' }]);
    const staleGuard = f.db
      .prepare(
        'INSERT INTO workspace_portfolio_sync_guards (workspace_id,projects_json,projection_hash,expected_previous_hash,preserve_outside_catalog_app_ids_json) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('ws', '[]', local.projection_hash, local.projection_hash, '[]');
    await expect(staleGuard.run()).rejects.toThrow('catalog revisions required');
    const concurrent = fixture();
    seed(concurrent, 39, 39);
    const old = await syncCatalog(concurrent.db, 'ws', input(), 1000);
    let raced = false;
    concurrent.beforeBatch(async () => {
      if (raced) return;
      raced = true;
      await syncCatalog(
        concurrent.db,
        'ws',
        CatalogSyncRequestV1.parse(
          completePublisherProjection({ ...input(), expected_previous_hash: old.projection_hash }),
        ),
        2000,
      );
    });
    const response = await handleCatalogSyncRoute(
      new Request('https://dashboard.example.com/v1/catalog/sync', {
        method: 'POST',
        body: JSON.stringify({ ...input(), expected_previous_hash: old.projection_hash }),
      }),
      concurrent.db,
      publisherOwner,
    );
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ code: 'revisions_required' });
  });
  it('rejects a delayed legacy policy PUT after a concurrent catalog upgrade without disturbing the new policy', async () => {
    const f = fixture();
    seed(f, 39, 39);
    let upgraded = false;
    f.beforeBatch(async () => {
      if (upgraded) return;
      upgraded = true;
      await syncCatalog(
        f.db,
        'ws',
        CatalogSyncRequestV1.parse(completePublisherProjection(input())),
        1000,
      );
    });
    const response = await handleMonitoringRoute(
      new Request('https://dashboard.example.com/v1/workspace/monitoring/policy', {
        method: 'PUT',
        body: JSON.stringify(input().monitoring),
      }),
      f.db,
      publisherOwner,
    );
    expect(response?.status).toBe(409);
    const legacyOther = await handleMonitoringRoute(
      new Request('https://dashboard.example.com/v1/workspace/monitoring/policy', {
        method: 'PUT',
        body: JSON.stringify(input().monitoring),
      }),
      f.db,
      { ...publisherOwner, id: 'other', workspaceId: 'foreign' },
    );
    expect(legacyOther?.status).toBe(200);

    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM workspace_monitoring_projects WHERE workspace_id = ?')
        .get('ws'),
    ).toEqual({ n: canonicalProjectCount });
    expect(
      f.sqlite
        .prepare(
          'SELECT count(*) AS n FROM workspace_monitoring_projects WHERE workspace_id = ? AND journey_revisions_json IS NULL',
        )
        .get('ws'),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare('SELECT workspace_id FROM workspace_catalog_revision_fences').all(),
    ).toEqual([{ workspace_id: 'ws' }]);
  });
  it('HMACs enrollment by IPv6 /64 with an existing runtime secret and fails closed without that secret', async () => {
    const f = fixture();
    const request = (ip: string) => {
      const req = publisherRequest('publisher/enroll', { label: 'Mac' });
      req.headers.set('cf-connecting-ip', ip);
      return req;
    };
    expect((await handleCatalogPublisherRuntime(request('192.0.2.1'), f.db, 1000))?.status).toBe(
      503,
    );
    for (const ip of [
      '2001:db8:1234:5678::1',
      '2001:db8:1234:5678:1::2',
      '2001:0db8:1234:5678:ffff::3',
      '2001:db8:1234:5678::ffff',
    ])
      expect((await handleCatalogPublisher(request(ip), f.db, 1000))?.status).toBe(201);
    expect(
      (await handleCatalogPublisher(request('2001:db8:1234:5678:abcd::4'), f.db, 1000))?.status,
    ).toBe(429);
    expect(
      (await handleCatalogPublisher(request('2001:db8:1234:5679::1'), f.db, 1000))?.status,
    ).toBe(201);
    const first = (
      f.sqlite.prepare('SELECT enrollment_key FROM catalog_publishers LIMIT 1').get() as {
        enrollment_key: string;
      }
    ).enrollment_key;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('0:v6:2001:db8:1234:5678/64'),
    );
    const unkeyed = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(first).not.toBe(unkeyed);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(['new-outside', 'archive-outside'] as const)(
    'fences initial owner approval against a live %s race',
    async (race) => {
      const f = fixture();
      seed(f, 40, 39, 1);
      await syncCatalog(
        f.db,
        'ws',
        { ...input(), preserve_outside_catalog_app_ids: ['app-39'] },
        1000,
      );
      const paired = await enrolledPublisher(f);
      const prepare = f.db.prepare.bind(f.db);
      f.db.prepare = (sql) => {
        const stmt = prepare(sql);
        if (sql.includes('UPDATE catalog_publishers SET workspace_id')) {
          const first = stmt.first.bind(stmt);
          stmt.first = async <T>() => {
            if (race === 'new-outside')
              f.sqlite.exec(
                "INSERT INTO apps(id,name,created_at) VALUES('late-outside','Late',1); INSERT INTO workspace_apps VALUES('late-outside','ws');",
              );
            else f.sqlite.prepare("UPDATE apps SET archived_at=2000 WHERE id='app-39'").run();
            return first<T>();
          };
        }
        return stmt;
      };
      expect((await approvePublisher(f, paired.code, ['app-39']))?.status).toBe(409);
      expect(f.sqlite.prepare('SELECT workspace_id FROM catalog_publishers').get()).toEqual({
        workspace_id: null,
      });
    },
  );
  it('returns a transient conflict rather than revocation when owner decisions change between publisher resolution and commit', async () => {
    const f = fixture();
    seed(f, 39, 39);
    const baseline = await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    f.beforeBatch(() => {
      f.sqlite
        .prepare('UPDATE catalog_publishers SET outside_app_ids_json=\'["already-reviewed"]\'')
        .run();
    });
    const response = await handleCatalogPublisher(
      publisherRequest(
        'publisher',
        { ...input(), expected_previous_hash: baseline.projection_hash },
        paired.secret,
      ),
      f.db,
      3000,
    );
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ code: 'conflict' });
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', undefined, paired.secret),
          f.db,
          4000,
        )
      )?.status,
    ).toBe(200);
  });
  it('retains only declared suspended incident state without executing or counting it, then supersedes it on re-admission', async () => {
    const f = fixture();
    seed(f, 39, 39);
    const definition = generated.journeys[0]!;
    const policy = input();
    policy.monitoring.projects = policy.monitoring.projects.map((row) => ({
      ...row,
      scope: 'local' as const,
      reason: 'Local fixture.',
      journeys: [],
      journey_revisions: {},
    }));
    const row = policy.monitoring.projects.find((item) => item.catalog_id === definition.project)!;
    row.scope = 'public';
    row.reason = null;
    row.journeys = [definition.journey];
    row.journey_revisions = { [definition.journey]: '0'.repeat(64) };
    const baseline = await syncCatalog(f.db, 'ws', policy, 1000);
    const key = await new D1ControlPlane(f.db).createKey('app-0', 'env-0', 2000);
    const id = `${definition.project}/${definition.journey}`;
    const prior = {
      status: 'failing',
      bad_streak: 1,
      good_streak: 0,
      incident_id: 'prior-open',
      opened_at: 1000,
    };
    const state = {
      schema_version: 1,
      journeys: { [id]: prior, 'removed/check': prior },
      revisions: { [id]: 'b'.repeat(64), 'removed/check': 'b'.repeat(64) },
      pending: [
        {
          log_id: 'removed-pending',
          event: 'journey.failed',
          props: { project: 'removed', journey: 'check' },
        },
      ],
    };
    f.sqlite
      .prepare(
        'INSERT INTO workspace_monitoring_runs (workspace_id,lease_id,lease_started_at,state_json) VALUES (?,?,?,?)',
      )
      .run('ws', 'old', 0, JSON.stringify(state));
    const env = {
      DB: f.db,
      APP_HEALTH_SELF_BACKEND_KEY: key.rawKey,
      APP_HEALTH_SELF_APP_ID: 'app-0',
      APP_HEALTH_SELF_ENVIRONMENT_ID: 'env-0',
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response('Failed', { status: 503 }));
    await runScheduledMonitoring(env, fetcher, 10000000);
    expect(fetcher).not.toHaveBeenCalled();
    const suspended = JSON.parse(
      (
        f.sqlite.prepare('SELECT state_json FROM workspace_monitoring_runs').get() as {
          state_json: string;
        }
      ).state_json,
    );
    expect(suspended.journeys).toEqual({ [id]: prior });
    expect(suspended.revisions).toEqual({ [id]: 'b'.repeat(64) });
    expect(suspended.pending).toEqual([]);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM log_events').get()).toEqual({ n: 0 });
    row.journey_revisions = { [definition.journey]: await probeDefinitionRevision(definition) };
    policy.expected_previous_hash = baseline.projection_hash;
    await syncCatalog(f.db, 'ws', policy, 11000000);
    await runScheduledMonitoring(env, fetcher, 13600000);
    expect(fetcher).toHaveBeenCalledOnce();
    const superseded = f.sqlite
      .prepare("SELECT props FROM log_events WHERE event='journey.superseded'")
      .get() as { props: string };
    expect(JSON.parse(superseded.props)).toMatchObject({
      incident_id: 'prior-open',
      reason: 'definition_changed',
    });
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM log_events WHERE log_id='removed-pending'").get(),
    ).toEqual({ n: 0 });
  });
  it('pairs once, removes an active project atomically and retains excluded identity, keys and history', async () => {
    const f = fixture();
    seed(f, 41, 40, 1);
    const historical = input();
    historical.projects.push({
      ...historical.projects.at(-1)!,
      catalog_id: 'legacy-39',
      name: 'Historical fixture',
    });
    historical.monitoring.projects.push({
      catalog_id: 'legacy-39',
      name: 'Historical fixture',
      scope: 'local',
      reason: 'Historical fixture.',
      journeys: [],
    });
    const initial = { ...historical, preserve_outside_catalog_app_ids: ['app-40'] };
    expect(initial.projects).toHaveLength(canonicalProjectCount + 1);
    const baseline = await syncCatalog(f.db, 'ws', initial, 1000);
    const paired = await enrolledPublisher(f);
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', input(), paired.secret),
          f.db,
          1500,
        )
      )?.status,
    ).toBe(403);
    expect((await approvePublisher(f, paired.code, ['app-40']))?.status).toBe(200);
    const tokenRows = f.sqlite.prepare('SELECT verifier_hash FROM catalog_publishers').all();
    expect(JSON.stringify(tokenRows)).not.toContain(paired.secret);
    const next = { ...historical, expected_previous_hash: baseline.projection_hash };
    next.projects = next.projects.slice(1);
    next.monitoring.projects = next.monitoring.projects.slice(1);
    const response = await handleCatalogPublisher(
      publisherRequest('publisher', next, paired.secret),
      f.db,
      3000,
    );
    expect(response?.status).toBe(200);
    const acknowledged = (await response!.json()) as { project_count: number };
    expect(acknowledged.project_count).toBe(canonicalProjectCount);
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM current_workspace_catalog WHERE workspace_id = ?')
        .get('ws'),
    ).toEqual({ n: canonicalProjectCount });
    expect(
      f.sqlite
        .prepare('SELECT count(*) AS n FROM workspace_monitoring_projects WHERE workspace_id = ?')
        .get('ws'),
    ).toEqual({ n: canonicalProjectCount });
    expect(f.sqlite.prepare("SELECT verifier_hash FROM keys WHERE id='stable-key'").get()).toEqual({
      verifier_hash: 'stable-verifier',
    });
    expect(
      f.sqlite.prepare("SELECT id FROM apps WHERE id IN ('app-0', 'app-40')").all(),
    ).toHaveLength(2);
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 4000))
        ?.status,
    ).toBe(200);
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', undefined, paired.secret),
          f.db,
          paired.expires_at + 86400000,
        )
      )?.status,
    ).toBe(200);
    const list = await handleCatalogPublisherOwner(publisherOwnerRequest(''), f.db, publisherOwner);
    const listed = JSON.stringify(await list!.json());
    expect(listed).not.toContain(paired.secret);
    expect(listed).not.toContain('verifier_hash');
    expect(listed).toContain('last_success_at');
  });

  it('requires the real workspace owner, explicit outside decisions and an unexpired code', async () => {
    const f = fixture();
    seed(f, 41, 40, 1);
    await syncCatalog(
      f.db,
      'ws',
      { ...input(), preserve_outside_catalog_app_ids: ['app-40'] },
      1000,
    );
    const paired = await enrolledPublisher(f);
    for (const owner of [
      { ...publisherOwner, workspaceRole: 'editor' as const },
      { ...publisherOwner, authKind: 'api-token' as const },
      { ...publisherOwner, appId: 'app-0' },
    ])
      expect(
        (
          await handleCatalogPublisherOwner(
            publisherOwnerRequest('/approve', {
              code: paired.code,
              allow_automatic_updates: true,
              preserve_outside_catalog_app_ids: ['app-40'],
            }),
            f.db,
            owner,
          )
        )?.status,
      ).toBe(403);
    expect((await approvePublisher(f, paired.code))?.status).toBe(409);
    const unconfirmed = publisherOwnerRequest('/approve', {
      code: paired.code,
      allow_automatic_updates: false,
      preserve_outside_catalog_app_ids: ['app-40'],
    });
    expect((await handleCatalogPublisherOwner(unconfirmed, f.db, publisherOwner))?.status).toBe(
      400,
    );
    const crossOrigin = publisherOwnerRequest('/approve', {
      code: paired.code,
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: ['app-40'],
    });
    crossOrigin.headers.set('origin', 'https://evil.example');
    expect((await handleCatalogPublisherOwner(crossOrigin, f.db, publisherOwner))?.status).toBe(
      403,
    );
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', undefined, paired.secret),
          f.db,
          paired.expires_at + 1,
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/approve', {
            code: paired.code,
            allow_automatic_updates: true,
            preserve_outside_catalog_app_ids: ['app-40'],
          }),
          f.db,
          publisherOwner,
          paired.expires_at + 1,
        )
      )?.status,
    ).toBe(409);
  });

  it('fences a revocation that occurs after authentication but before the SQL commit', async () => {
    const f = fixture();
    seed(f, 40, 40);
    const baseline = await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    expect((await approvePublisher(f, paired.code))?.status).toBe(200);
    const next = { ...input(), expected_previous_hash: baseline.projection_hash };
    next.projects[0]!.name = 'Must not commit';
    next.monitoring.projects[0]!.name = 'Must not commit';
    f.beforeBatch(() => {
      f.sqlite
        .prepare('UPDATE catalog_publishers SET revoked_at = 2500 WHERE id = ?')
        .run(paired.publisher_id);
    });
    expect(
      (await handleCatalogPublisher(publisherRequest('publisher', next, paired.secret), f.db, 3000))
        ?.status,
    ).toBe(401);
    expect(
      f.sqlite.prepare('SELECT projection_hash FROM workspace_portfolio_snapshots').get(),
    ).toEqual({ projection_hash: baseline.projection_hash });
    expect(
      f.sqlite
        .prepare('SELECT name FROM workspace_monitoring_projects ORDER BY catalog_id LIMIT 1')
        .get(),
    ).not.toEqual({ name: 'Must not commit' });
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', undefined, paired.secret),
          f.db,
          4000,
        )
      )?.status,
    ).toBe(401);
  });

  it('cannot choose its workspace or expand outside acknowledgements and stops for newly unlinked apps', async () => {
    const f = fixture();
    seed(f, 40, 40);
    const baseline = await syncCatalog(f.db, 'ws', input(), 1000);
    const paired = await enrolledPublisher(f);
    await approvePublisher(f, paired.code);
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', { ...input(), workspace_id: 'foreign' }, paired.secret),
          f.db,
          3000,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest(
            'publisher',
            { ...input(), preserve_outside_catalog_app_ids: ['app-0'] },
            paired.secret,
          ),
          f.db,
          3000,
        )
      )?.status,
    ).toBe(400);
    f.sqlite.exec(
      "INSERT INTO apps VALUES ('new-outside', 'Outside', 1, NULL); INSERT INTO workspace_apps VALUES ('new-outside','ws');",
    );
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest(
            'publisher',
            { ...input(), expected_previous_hash: baseline.projection_hash },
            paired.secret,
          ),
          f.db,
          3000,
        )
      )?.status,
    ).toBe(409);
    expect(
      f.sqlite.prepare('SELECT projection_hash FROM workspace_portfolio_snapshots').get(),
    ).toEqual({ projection_hash: baseline.projection_hash });
    expect(f.sqlite.prepare('SELECT last_error FROM catalog_publishers').get()).toEqual({
      last_error: 'review_required',
    });
  });

  it('binds a pairing code to exactly one owner workspace and isolates revocation', async () => {
    const f = fixture();
    seed(f, 40, 40);
    await syncCatalog(f.db, 'ws', input(), 1000);
    await syncCatalog(f.db, 'foreign', input(), 1000);
    const paired = await enrolledPublisher(f);
    const body = {
      code: paired.code,
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: [],
    };
    const replies = await Promise.all([
      handleCatalogPublisherOwner(
        publisherOwnerRequest('/approve', body),
        f.db,
        publisherOwner,
        2000,
      ),
      handleCatalogPublisherOwner(
        publisherOwnerRequest('/approve', body),
        f.db,
        { ...publisherOwner, workspaceId: 'foreign', id: 'other' },
        2000,
      ),
    ]);
    expect(replies.map((r) => r!.status).sort()).toEqual([200, 409]);
    const bound = f.sqlite.prepare('SELECT workspace_id FROM catalog_publishers').get() as {
      workspace_id: string;
    };
    const other = bound.workspace_id === 'ws' ? 'foreign' : 'ws';
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/revoke', { publisher_id: paired.publisher_id }),
          f.db,
          { ...publisherOwner, workspaceId: other },
          3000,
        )
      )?.status,
    ).toBe(404);
    expect(
      (
        await handleCatalogPublisherOwner(
          publisherOwnerRequest('/revoke', { publisher_id: paired.publisher_id }),
          f.db,
          { ...publisherOwner, workspaceId: bound.workspace_id },
          3000,
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await handleCatalogPublisher(
          publisherRequest('publisher', undefined, paired.secret),
          f.db,
          4000,
        )
      )?.status,
    ).toBe(401);
  });
});
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
          index < Math.min(mappings, projects.length)
            ? projects[index]!.catalog_id
            : `legacy-${index}`,
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
    expect(projected.projects).toHaveLength(canonicalProjectCount);
    expect(canonicalPublicProjectIds).toContain('techdata');
    expect(canonicalPublicProjectIds).not.toContain('protein-index');
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
    expect(projected.monitoring.projects.filter((row) => row.scope === 'public')).toHaveLength(
      canonicalPublicProjectIds.length,
    );
    expect(JSON.stringify(projected)).not.toMatch(
      /PRIVATE_CANARY|localPath|ignored.invalid|ownerNotes/,
    );
    const source = canonical();
    source.projects[0]!.lifecycle.portfolioStatus = 'archived';
    expect(projectCanonicalCatalog(source, null).projects).toHaveLength(canonicalProjectCount - 1);
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

  it('converges 57 owned records to the canonical visible projects, preserving IDs, environments, keys and immutable receipts', async () => {
    const f = fixture();
    seed(f, 57, 36, 1);
    const expectedAppRecords = 57 + canonicalProjectCount - 36;
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
    expect(listed).toHaveLength(canonicalProjectCount);
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
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({
      n: expectedAppRecords,
    });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_monitoring_projects').get(),
    ).toEqual({ n: canonicalProjectCount });
    expect(
      f.sqlite.prepare('SELECT count(*) AS n FROM workspace_portfolio_sync_guards').get(),
    ).toEqual({ n: 0 });
    const retry = await syncCatalog(f.db, 'ws', input(), 11);
    expect(retry.projection_hash).toBe(first.projection_hash);
    expect(
      (
        await currentPortfolioAnalyticsSnapshot(
          f.db,
          'ws',
          (
            f.sqlite
              .prepare('SELECT app_id FROM workspace_apps WHERE workspace_id = ?')
              .all('ws') as { app_id: string }[]
          ).map((row) => row.app_id),
        )
      ).appIds,
    ).toHaveLength(canonicalProjectCount);
    const health = await new D1WorkspaceHealth(f.db, 'ws').queryWorkspaceHealth(1750000000000);
    expect(health.environments).toHaveLength(canonicalProjectCount);
    expect(health.environments.find((row) => row.app_id === 'app-0')?.app_name).toBe('Canonical 0');
    expect(await plane.listApps()).toHaveLength(canonicalProjectCount);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual({
      n: expectedAppRecords,
    });
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
    const manuallyLinkedProject = input().projects.at(-1)!;
    f.sqlite
      .prepare('UPDATE apps SET name = ? WHERE id = ?')
      .run(manuallyLinkedProject.name, 'app-56');
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
      unlinked_apps: [{ app_id: 'app-56', name: manuallyLinkedProject.name }],
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
            catalog_id: manuallyLinkedProject.catalog_id,
            name: manuallyLinkedProject.name,
            lifecycle: 'active',
            existing_app_id: 'app-56',
          },
        ],
      }),
      11,
    );
    const appRecordsAfterExplicitLink = f.sqlite
      .prepare('SELECT count(*) AS n FROM apps')
      .get() as { n: number };
    await syncCatalog(f.db, 'ws', input(), 12);
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM apps').get()).toEqual(
      appRecordsAfterExplicitLink,
    );
    expect(
      (await new D1ControlPlane(f.db, 'ws').listApps()).find((row) => row.id === 'app-56')?.name,
    ).toBe(manuallyLinkedProject.name);
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
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(canonicalProjectCount);
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
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(canonicalProjectCount);
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
    next.projects.push({
      ...next.projects.at(-1)!,
      catalog_id: 'outside-service',
      name: 'Outside service joins',
    });
    next.monitoring.projects.push({
      catalog_id: 'outside-service',
      name: 'Outside service joins',
      scope: 'private',
      reason: 'Private service.',
      journeys: [],
    });
    await syncCatalog(f.db, 'ws', next, 13);
    expect(
      (await new D1ControlPlane(f.db, 'ws').listApps()).find((app) => app.id === 'app-56')?.name,
    ).toBe('Outside service joins');
    expect(await new D1ControlPlane(f.db, 'ws').listApps()).toHaveLength(canonicalProjectCount + 1);
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
    const prior = await currentPortfolioAnalyticsSnapshot(f.db, 'ws', ['app-0', 'app-56']);
    expect(prior).toEqual({ appIds: ['app-0', 'app-56'], projectionHash: 'manual' });
    const old = snapshotCachedAnalytics(
      prior,
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
    const { projection_hash } = await syncCatalog(f.db, 'ws', input(), 10);
    const snapshot = await currentPortfolioAnalyticsSnapshot(f.db, 'ws', ['app-0', 'app-56']);
    expect(snapshot).toEqual({ appIds: ['app-0'], projectionHash: projection_hash });
    const current = () =>
      snapshotCachedAnalytics(
        snapshot,
        'owner',
        'ws',
        'cohort',
        async () => (await new D1ControlPlane(f.db, 'ws').listApps()).length,
        adapter,
      );
    expect(await current()).toBe(canonicalProjectCount);
    finishOld(57);
    expect(await old).toBe(57);
    expect(await current()).toBe(canonicalProjectCount);
  });

  it('shares one catalog read for default reports and summary while preserving explicit historical reads', async () => {
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
    const prepare = vi.spyOn(f.db, 'prepare');
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
    expect(prepare.mock.calls).toEqual([
      [
        'SELECT projects_json, projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = ?',
      ],
    ]);
    prepare.mockClear();
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
    expect(prepare.mock.calls).toEqual([
      ['SELECT projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = ?'],
    ]);
    prepare.mockClear();

    const summary = await handleBrowserOwner(
      new Request('https://dashboard.test/v1/analytics'),
      {
        ...env,
        BROWSER_EVENTS: { send: async () => {} },
        WORKSPACE_PRESENCE: {
          getByName: () => ({
            heartbeat: async () => {},
            fetch: async () => new Response(null, { status: 501 }),
            snapshot: async () => ({
              measured_at: 10,
              ttl_ms: 45000,
              total: 3,
              projects: [
                { app_id: 'app-0', environment_id: 'env-0', active: 1 },
                { app_id: 'app-56', environment_id: 'env-56', active: 2 },
              ],
            }),
          }),
        },
      },
      owner,
      false,
    );
    expect(summary?.status).toBe(200);
    expect(await summary?.json()).toMatchObject({
      live: { total: 1, projects: [{ app_id: 'app-0', environment_id: 'env-0', active: 1 }] },
    });
    expect(prepare.mock.calls).toEqual([
      [
        'SELECT projects_json, projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = ?',
      ],
    ]);
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
    expect(projected.projects).toHaveLength(37);
    expect(projected.projects.map((row) => row.catalog_id)).toContain('techdata');
    expect(projected.projects.map((row) => row.catalog_id)).not.toContain('protein-index');
    expect(
      projected.projects.filter((row) =>
        ['local-only', 'private-authenticated'].includes(row.auth_model),
      ),
    ).toHaveLength(8);
    expect(projected.projects.filter((row) => row.future_form === 'support-tool')).toHaveLength(5);
    expect(projected.projects.filter((row) => row.future_form === 'personal-tool')).toHaveLength(
      15,
    );
    expect(projected.monitoring.projects.filter((row) => row.scope === 'public')).toHaveLength(35);
    expect(projected.monitoring.projects.reduce((sum, row) => sum + row.journeys.length, 0)).toBe(
      43,
    );
    expect(
      projected.projects.find((row) => row.catalog_id === 'site-health')?.browser_visitors,
    ).toBe('not_applicable');
  },
);
