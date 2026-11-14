import { expect, it } from 'vitest';
import { MonitoringPolicyV1 } from '@app-health/contracts';
import {
  handleMonitoringRoute,
  readMonitoringReport,
  saveMonitoringPolicy,
} from '../src/monitoring.js';
import { importCatalogProjects } from '../src/catalog-import.js';
import { analysisDatabase } from './analysis-sqlite.js';
import { ownerRouteAllowed } from '../src/access-policy.js';
import type { OwnerIdentity } from '../src/identity.js';
import worker, { type Env } from '../src/index.js';
import { createApiToken } from '../src/workspace-access.js';

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
