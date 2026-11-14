import { expect, it } from 'vitest';
import { MonitoringPolicyV1, type MonitoringReport } from '@app-health/contracts';
import {
  handleMonitoringRoute,
  readMonitoringReport as readReport,
  saveMonitoringPolicy,
} from '../src/monitoring.js';
import { importCatalogProjects } from '../src/catalog-import.js';
import { analysisDatabase } from './analysis-sqlite.js';
import { ownerRouteAllowed } from '../src/access-policy.js';
import type { OwnerIdentity } from '../src/identity.js';
import worker, { type Env } from '../src/index.js';
import { createApiToken } from '../src/workspace-access.js';
import { D1ControlPlane } from '../src/d1-adapter.js';
import { readOwnerAlertFeed } from '../src/alert-feed.js';

// This fixture explicitly designates app/env as its trusted probe sender.
const readMonitoringReport: typeof readReport = (
  db,
  workspace,
  time,
  scope,
  source = { appId: 'app', environmentId: 'env' },
) => readReport(db, workspace, time, scope, source);
const owner: OwnerIdentity = {
  id: 'user',
  label: 'Owner',
  authKind: 'account',
  workspaceRole: 'owner',
  workspaceId: 'ws',
};
const now = 1800000000000;
const policy = MonitoringPolicyV1.parse({
  schema_version: 1,
  projects: [
    {
      catalog_id: 'product',
      name: 'Product',
      scope: 'public',
      reason: null,
      journeys: ['home', 'api'],
    },
    {
      catalog_id: 'not-linked',
      name: 'New project',
      scope: 'public',
      reason: null,
      journeys: ['home'],
    },
    {
      catalog_id: 'local',
      name: 'Local',
      scope: 'local',
      reason: 'Local service only.',
      journeys: [],
    },
  ],
});

it('keeps the declared roster complete, requires fresh results for each expected check, and isolates senders', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'product',
            name: 'Product',
            lifecycle: 'active',
            hostname: null,
            repository: null,
            existing_app_id: 'app',
          },
        ],
      },
      now,
    );
    await saveMonitoringPolicy(db, 'ws', policy, now);
    const insert = (
      id: string,
      journey: string,
      timestamp: number,
      status: string,
      extra: Record<string, unknown> = {},
      app = 'app',
      environment = 'env',
      source = 'server',
    ) =>
      sqlite
        .prepare(
          `INSERT INTO log_events
        (log_id, app_id, environment_id, timestamp, event, level, props, source)
        VALUES (?, ?, ?, ?, 'probe.result', 'debug', ?, ?)`,
        )
        .run(
          id,
          app,
          environment,
          timestamp,
          JSON.stringify({
            project: 'product',
            journey,
            location: 'india',
            interval_seconds: 300,
            status,
            total_ms: 70,
            ...extra,
          }),
          source,
        );
    insert('old-failure', 'home', now - 120000, 'failing');
    insert('recovery', 'home', now - 60000, 'healthy', { email: 'private' });
    insert('foreign', 'api', now - 1000, 'healthy', {}, 'other-app', 'other-env');
    insert('browser', 'api', now - 1000, 'healthy', {}, 'app', 'env', 'browser');
    let report = await readMonitoringReport(db, 'ws', now);
    expect(report.projects).toHaveLength(3);
    expect(report.projects.find((p) => p.catalog_id === 'not-linked')?.state).toBe('unconfigured');
    expect(report.projects.find((p) => p.catalog_id === 'local')?.state).toBe('local');
    expect(report.projects.find((p) => p.catalog_id === 'product')).toMatchObject({
      state: 'missing',
      checks: [{ health: 'healthy' }, { freshness: 'missing', health: null }],
    });
    insert('api', 'api', now - 500, 'failing', { failure: 'timeout' });
    report = await readMonitoringReport(db, 'ws', now);
    expect(report.projects.find((p) => p.catalog_id === 'product')?.state).toBe('failing');
    insert('offline', 'api', now - 100, 'healthy', { vantage_offline: true });
    report = await readMonitoringReport(db, 'ws', now);
    expect(report.projects.find((p) => p.catalog_id === 'product')?.state).toBe('offline');
    expect(JSON.stringify(report)).not.toContain('private');
    const stale = await readMonitoringReport(db, 'ws', now + 1000000);
    expect(stale.projects.find((p) => p.catalog_id === 'product')).toMatchObject({
      state: 'stale',
    });
    expect(
      stale.projects
        .find((p) => p.catalog_id === 'product')
        ?.checks.every((c) => c.health === null),
    ).toBe(true);
    expect((await readMonitoringReport(db, 'foreign', now)).projects).toEqual([]);
    expect(
      (
        await readMonitoringReport(db, 'ws', now, {
          appId: 'other-app',
          environmentId: 'other-env',
        })
      ).projects,
    ).toEqual([]);
    expect(
      (
        await readMonitoringReport(db, 'ws', now, { appId: 'app', environmentId: 'env' })
      ).projects.map((p) => p.catalog_id),
    ).toEqual(['product']);
    await saveMonitoringPolicy(
      db,
      'ws',
      { schema_version: 1, projects: [policy.projects[2]] },
      now + 1,
    );
    expect(
      (await readMonitoringReport(db, 'ws', now + 1)).projects.map((p) => p.catalog_id),
    ).toEqual(['local']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM log_events').get()?.n).toBe(6);
  } finally {
    sqlite.close();
  }
});

it('requires account owner mutations and explicit scoped API-token reads', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    const put = () =>
      new Request('https://health.test/v1/workspace/monitoring/policy', {
        method: 'PUT',
        body: JSON.stringify(policy),
        headers: { 'content-type': 'application/json' },
      });
    expect(
      (await handleMonitoringRoute(put(), db, { ...owner, workspaceRole: 'viewer' }))?.status,
    ).toBe(403);
    expect(
      (
        await handleMonitoringRoute(put(), db, {
          ...owner,
          authKind: 'api-token',
          apiPermission: 'manage',
        })
      )?.status,
    ).toBe(403);
    expect((await handleMonitoringRoute(put(), db, owner))?.status).toBe(200);
    expect(
      (
        await handleMonitoringRoute(
          new Request('https://health.test/v1/workspace/monitoring/policy', {
            method: 'PUT',
            body: '{',
          }),
          db,
          owner,
        )
      )?.status,
    ).toBe(400);
    const token: OwnerIdentity = {
      ...owner,
      authKind: 'api-token',
      apiPermission: 'read',
      apiScopes: [{ app_id: 'app', environment_id: 'env' }],
    };
    for (const path of ['/v1/workspace/monitoring', '/v1/workspace/alerts']) {
      expect(ownerRouteAllowed(new Request(`https://health.test${path}`), token)).toBe(false);
      expect(
        ownerRouteAllowed(
          new Request(`https://health.test${path}?app_id=other-app&environment_id=other-env`),
          token,
        ),
      ).toBe(false);
      expect(
        ownerRouteAllowed(
          new Request(`https://health.test${path}?app_id=app&environment_id=env`),
          token,
        ),
      ).toBe(true);
    }
    expect(
      (
        await handleMonitoringRoute(
          new Request('https://health.test/v1/workspace/monitoring?app_id=app'),
          db,
          owner,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleMonitoringRoute(
          new Request('https://health.test/v1/workspace/monitoring'),
          undefined,
          owner,
        )
      )?.status,
    ).toBe(503);
  } finally {
    sqlite.close();
  }
});

it('rejects duplicated or ambiguous policy declarations', () => {
  expect(
    MonitoringPolicyV1.safeParse({ ...policy, projects: [policy.projects[0], policy.projects[0]] })
      .success,
  ).toBe(false);
  expect(
    MonitoringPolicyV1.safeParse({ ...policy, projects: [{ ...policy.projects[0], journeys: [] }] })
      .success,
  ).toBe(false);
  expect(
    MonitoringPolicyV1.safeParse({ ...policy, projects: [{ ...policy.projects[2], reason: null }] })
      .success,
  ).toBe(false);
});

it('dispatches monitoring and alerts through MCP with actual token scope enforcement', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'product',
            name: 'Product',
            lifecycle: 'active',
            hostname: null,
            repository: null,
            existing_app_id: 'app',
          },
        ],
      },
      now,
    );
    await saveMonitoringPolicy(db, 'ws', policy, now);
    const token = await createApiToken(db, owner, {
      name: 'Monitoring',
      permission: 'read',
      scopes: [{ app_id: 'app', environment_id: 'env' }],
    });
    const env: Env = {
      DB: db,
      APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
      APP_HEALTH_INGEST_HOST: 'ingest.test',
      APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
      OWNER_AUTH_TOKEN: 'synthetic-owner-secret-for-monitoring-tests',
      CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
      TELEMETRY: { writeDataPoint() {} },
    };
    const call = async (name: string, appId = 'app', environmentId = 'env') => {
      const response = await worker.fetch(
        new Request('https://dashboard.test/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: { app_id: appId, environment_id: environmentId } },
          }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
    };
    const monitoring = (await call('monitoring_report')).result;
    expect(monitoring.isError).toBe(false);
    expect(
      JSON.parse(monitoring.content[0].text).projects.map(
        (p: { catalog_id: string }) => p.catalog_id,
      ),
    ).toEqual(['product']);
    const alerts = (await call('alerts')).result;
    expect(alerts.isError).toBe(false);
    expect(JSON.parse(alerts.content[0].text)).toMatchObject({
      total_count: 0,
      entries: [],
      probes: [],
    });
    for (const name of ['monitoring_report', 'alerts']) {
      const denied = (await call(name, 'other-app', 'other-env')).result;
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0].text)).toEqual({
        error: 'Credential or workspace role does not permit this route',
      });
    }
  } finally {
    sqlite.close();
  }
});

it('keeps the ten most recent locations without failing the workspace for retired locations', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'product',
            name: 'Product',
            lifecycle: 'active',
            hostname: null,
            repository: null,
            existing_app_id: 'app',
          },
        ],
      },
      now,
    );
    await saveMonitoringPolicy(db, 'ws', policy, now);
    const insert = sqlite.prepare(
      `INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, level, props, source) VALUES (?, 'app', 'env', ?, 'probe.result', 'debug', ?, 'server')`,
    );
    for (let i = 0; i < 15; i++)
      insert.run(
        `location-${i}`,
        now - i * 1000,
        JSON.stringify({
          project: 'product',
          journey: 'home',
          location: `location-${i}`,
          interval_seconds: 300,
          status: 'healthy',
        }),
      );
    const result = await readMonitoringReport(db, 'ws', now);
    const check = result.projects.find((p) => p.catalog_id === 'product')!.checks[0];
    expect(result.projects).toHaveLength(3);
    expect(check.observations.map((o) => o.location)).toEqual(
      Array.from({ length: 10 }, (_, i) => `location-${i}`),
    );
    expect(check.health).toBe('healthy');
    expect(
      (await readReport(db, 'ws', now)).projects.find((p) => p.catalog_id === 'product')!.checks[0]
        .freshness,
    ).toBe('missing');
  } finally {
    sqlite.close();
  }
});

it('rejects another owned app impersonating the designated probe through REST and MCP', async () => {
  const { db, sqlite } = analysisDatabase();
  const timestamp = Date.now();
  try {
    sqlite.exec(`INSERT INTO workspace_apps VALUES ('other-app', 'ws');
      INSERT INTO apps(id, name, created_at) VALUES ('rogue-app', 'Unrelated', 1);
      INSERT INTO environments(id, app_id, name, created_at) VALUES ('rogue-env', 'rogue-app', 'production', 1);
      INSERT INTO workspace_apps VALUES ('rogue-app', 'ws');`);
    await importCatalogProjects(
      db,
      'ws',
      {
        schema_version: 1,
        projects: [
          {
            catalog_id: 'self',
            name: 'Self',
            existing_app_id: 'app',
            lifecycle: 'active',
            hostname: null,
            repository: null,
          },
          {
            catalog_id: 'product',
            name: 'Product',
            existing_app_id: 'other-app',
            lifecycle: 'active',
            hostname: null,
            repository: null,
          },
          {
            catalog_id: 'rogue',
            name: 'Unrelated',
            existing_app_id: 'rogue-app',
            lifecycle: 'active',
            hostname: null,
            repository: null,
          },
        ],
      },
      timestamp,
    );
    await saveMonitoringPolicy(
      db,
      'ws',
      { schema_version: 1, projects: [policy.projects[0]] },
      timestamp,
    );
    const control = new D1ControlPlane(db);
    const trusted = await control.createKey('app', 'env', timestamp);
    const rogue = await control.createKey('rogue-app', 'rogue-env', timestamp);
    const token = await createApiToken(db, owner, {
      name: 'Victim only',
      permission: 'read',
      scopes: [{ app_id: 'other-app', environment_id: 'other-env' }],
    });
    const env: Env = {
      DB: db,
      APP_HEALTH_SELF_BACKEND_KEY: trusted.rawKey,
      APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
      APP_HEALTH_INGEST_HOST: 'ingest.test',
      APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
      OWNER_AUTH_TOKEN: 'synthetic-owner-secret-for-monitoring-tests',
      CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
      TELEMETRY: { writeDataPoint() {} },
    };
    const ingest = async (key: string, status: string) => {
      const logs = ['probe.result', 'journey.failed', 'probe.heartbeat'].map((event) => ({
        log_id: crypto.randomUUID(),
        timestamp,
        event,
        level: event === 'journey.failed' ? 'error' : 'debug',
        title: 'Synthetic fixture',
        props: {
          project: 'product',
          journey: 'home',
          location: 'cloudflare-hourly',
          status,
          interval_seconds: 3600,
        },
      }));
      const response = await worker.fetch(
        new Request('https://ingest.test/v1/logs', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            schema_version: 'v1',
            batch_id: crypto.randomUUID(),
            environment: 'production',
            logs,
          }),
        }),
        env,
      );
      expect(response.status).toBe(202);
    };
    const read = async (path: string, mcp = false) => {
      const response = await worker.fetch(
        new Request(
          `https://dashboard.test${mcp ? '/mcp' : `/v1/workspace/${path}?app_id=other-app&environment_id=other-env`}`,
          {
            method: mcp ? 'POST' : 'GET',
            headers: {
              authorization: `Bearer ${token.token}`,
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            ...(mcp
              ? {
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                      name: path === 'monitoring' ? 'monitoring_report' : 'alerts',
                      arguments: { app_id: 'other-app', environment_id: 'other-env' },
                    },
                  }),
                }
              : {}),
          },
        ),
        env,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: { content: { text: string }[] } };
      return (mcp ? JSON.parse(body.result.content[0].text) : body) as MonitoringReport & {
        total_count: number;
        entries: { app_id: string }[];
      };
    };
    await ingest(rogue.rawKey, 'healthy');
    for (const mcp of [false, true]) {
      expect(
        (await read('monitoring', mcp)).projects[0].checks.every(
          (c: { freshness: string }) => c.freshness === 'missing',
        ),
      ).toBe(true);
      expect((await read('alerts', mcp)).total_count).toBe(0);
    }
    await ingest(trusted.rawKey, 'failing');
    for (const mcp of [false, true]) {
      expect((await read('monitoring', mcp)).projects[0].state).toBe('failing');
      expect((await read('alerts', mcp)).entries.map((e: { app_id: string }) => e.app_id)).toEqual([
        'other-app',
      ]);
    }
    sqlite.exec("DELETE FROM workspace_apps WHERE app_id = 'other-app'");
    expect(
      (
        await readOwnerAlertFeed(db, 'ws', Date.now(), undefined, undefined, {
          appId: 'app',
          environmentId: 'env',
        })
      ).entries,
    ).toEqual([]);
    sqlite.exec("INSERT INTO workspace_apps VALUES ('other-app', 'ws')");
    await control.revokeKey(trusted.record.id, timestamp + 1);
    expect((await read('monitoring')).projects[0].state).toBe('missing');
    expect((await read('alerts')).total_count).toBe(0);
  } finally {
    sqlite.close();
  }
});
