import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import { URL as NodeURL } from 'node:url';
import { Miniflare } from 'miniflare';
import { makeSignature } from 'better-auth/crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { BrowserReportFilter } from '@app-health/contracts';
import worker, { type Env } from '../src/index.js';
import { createAccountAuth } from '../src/accounts.js';
import { snapshotCachedAnalytics } from '../src/analytics-cache.js';
import { splitMigrationSql } from './migration-sql.js';
import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { browserReportPlan } from '../src/browser-report-plan.js';
import { reportWindow } from '../src/browser-report-window.js';
import { rankingFixture, observable, isPeriods } from './ranking-report-fixture.js';

const mf = new Miniflare({
  modules: true,
  script: 'export default {fetch(){return new Response("ok")}}',
  d1Databases: ['DB'],
});
const data = rankingFixture();
const originalFetch = globalThis.fetch;
let env: Env;
let cookie: string;
let workspace: string;
let scope: { app_id: string; environment_id: string };
let server: Server;
let providerOrigin: string;
let mode = 'normal';
let dispatches: string[] = [];
let headerStarts: string[] = [];
let peakWaitingHeaders = 0;
let dispatchesAtFirstHeaders: number | undefined;
let queries: string[] = [];
const entries = new Map<string, Response>();
const ttl: string[] = [];
let cacheEnabled = false;
let speculativeClosed = false;
const filter = () => BrowserReportFilter.parse({ ...scope, range: '24h', date: '2026-11-12' });
const request = (path: string, body?: unknown, authenticated = true) =>
  worker.fetch(
    new Request(`https://dashboard.example.com${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(authenticated ? { cookie } : {}),
        origin: 'https://dashboard.example.com',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );
const report = (extra: Partial<BrowserReportFilter> = {}) =>
  request('/v1/analytics/report?' + new URLSearchParams({ ...filter(), ...extra }));

beforeAll(async () => {
  const db = await mf.getD1Database('DB');
  const migrations = new NodeURL('../migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort())
    for (const statement of splitMigrationSql(
      await readFile(new NodeURL(name, migrations), 'utf8'),
    ))
      await db.prepare(statement).run();
  env = {
    DB: db,
    APP_HEALTH_ACCOUNTS: 'enabled',
    APP_HEALTH_DASHBOARD_HOST: 'dashboard.example.com',
    APP_HEALTH_INGEST_HOST: 'ingest.example.com',
    APP_HEALTH_INGEST_ORIGIN: 'https://ingest.example.com',
    GOOGLE_CLIENT_ID: 'synthetic',
    GOOGLE_CLIENT_SECRET: 'synthetic',
    BETTER_AUTH_SECRET: 'synthetic-test-auth-secret-at-least-32-characters',
    OWNER_AUTH_TOKEN: 'synthetic-owner',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic-query',
    TELEMETRY: { writeDataPoint() {} },
    BROWSER_ANALYTICS: { writeDataPoint() {} },
  };
  const context = await createAccountAuth(env)!.$context;
  const user = await context.internalAdapter.createUser(
    { name: 'Ranking owner', email: 'ranking@example.com', emailVerified: true },
    { method: 'oauth' },
  );
  const session = await context.internalAdapter.createSession(user.id, false);
  const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET!);
  cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
  workspace = ((await (await request('/v1/account')).json()) as { workspace: { id: string } })
    .workspace.id;
  const created = await request('/v1/apps', { name: 'Ranking fixture', environment: 'production' });
  expect(created.status).toBe(201);
  const app = (await created.json()) as { app: { id: string }; environment: { id: string } };
  scope = { app_id: app.app.id, environment_id: app.environment.id };
  server = createServer(async (incoming, response) => {
    let sql = '';
    for await (const part of incoming) sql += String(part);
    queries.push(sql);
    const optional = sql.includes('pageview_sessions') || sql.includes('argMax');
    const joint = sql.includes('GROUP BY event_kind');
    if (joint && mode === 'joint-http') {
      response.writeHead(503);
      response.end('unavailable');
      return;
    }
    if (joint && mode === 'joint-bodycap') {
      response.on('close', () => {
        speculativeClosed = true;
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write(' '.repeat(1024 * 1024 + 1));
      return;
    }
    if (isPeriods(sql) && mode === 'core-headers') return;
    if (isPeriods(sql) && mode === 'core-body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":');
      return;
    }
    if (optional && mode === 'optional-failure') {
      response.writeHead(503);
      response.end();
      return;
    }
    const rows = data.database.prepare(sqliteAnalyticsSql(sql)).all();
    const timer = setTimeout(
      () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
        const body = setTimeout(() => response.end(JSON.stringify({ data: rows })), 10);
        response.on('close', () => clearTimeout(body));
      },
      optional ? 80 : 10,
    );
    response.on('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No provider port');
  providerOrigin = `http://127.0.0.1:${address.port}`;
}, 30_000);
afterEach(() => {
  vi.unstubAllGlobals();
  cacheEnabled = false;
  entries.clear();
  ttl.length = 0;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  data.database.close();
  await mf.dispose();
});
function setup(count = 8) {
  data.database.exec('DELETE FROM app_health_browser_v1');
  const from = Date.parse('2026-11-12T00:00:00+05:30');
  for (let i = 0; i < count; i++)
    data.add({
      index1: workspace,
      blob1: scope.app_id,
      blob2: scope.environment_id,
      double2: from + 1000 + i,
    });
  data.add({
    index1: 'foreign',
    blob1: scope.app_id,
    blob2: scope.environment_id,
    double2: from + 1000,
  });
  queries = [];
  dispatches = [];
  headerStarts = [];
  peakWaitingHeaders = 0;
  dispatchesAtFirstHeaders = undefined;
  speculativeClosed = false;
  let waitingHeaders = 0;
  const queued: Array<() => void> = [];
  const providerFetch: typeof fetch = async (_input, init) => {
    const sql = String(init?.body);
    dispatches.push(sql);
    await new Promise<void>((resolve) => {
      const start = () => {
        waitingHeaders++;
        peakWaitingHeaders = Math.max(peakWaitingHeaders, waitingHeaders);
        headerStarts.push(sql);
        resolve();
      };
      if (waitingHeaders < 6) start();
      else queued.push(start);
    });
    try {
      const response = await originalFetch(providerOrigin, init);
      dispatchesAtFirstHeaders ??= dispatches.length;
      return response;
    } finally {
      waitingHeaders--;
      queued.shift()?.();
    }
  };
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://api.cloudflare.com/')
      ? providerFetch(input, init)
      : originalFetch(input, init),
  );
  vi.stubGlobal('caches', {
    default: {
      match: async (key: Request) => (cacheEnabled ? entries.get(key.url)?.clone() : undefined),
      put: async (key: Request, value: Response) => {
        ttl.push(value.headers.get('cache-control')!);
        if (cacheEnabled) entries.set(key.url, value.clone());
      },
    },
  });
}

function expectedDispatches(extra: Partial<BrowserReportFilter> = {}) {
  const selected = { ...filter(), ...extra };
  const { from, to, step } = reportWindow(selected, Date.now());
  const { sql, jointSql } = browserReportPlan(workspace, selected, from, to, step, [scope.app_id]);
  return jointSql
    ? [...(selected.source ? [] : sql.slice(-2)), sql[0], sql[1], sql[4], jointSql]
    : sql;
}

it('gives long optional queries a first-wave header slot in the six-call eager plan', async () => {
  setup();
  mode = 'normal';
  const pending = report();
  await vi.waitFor(() => expect(dispatches).toHaveLength(6));
  expect(dispatches).toEqual(expectedDispatches());
  const response = await pending;
  expect(response.status).toBe(200);
  expect(queries).toHaveLength(6);
  expect(dispatchesAtFirstHeaders).toBe(6);
  expect(peakWaitingHeaders).toBe(6);
  expect(headerStarts.slice(0, 6).some((sql) => sql.includes('pageview_sessions'))).toBe(true);
  expect(headerStarts.slice(0, 6).some((sql) => sql.includes('argMax'))).toBe(true);
  const body = (await response.json()) as {
    series: Array<{ pageviews: number }>;
    engagement?: unknown;
  };
  expect(body.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(8);
  expect(body.engagement).toBeDefined();
});

it.each([
  { count: 8, breakdown: 'audience' as const },
  { count: 8, breakdown: 'technology' as const },
  { count: 8, breakdown: 'acquisition' as const },
  { count: 30, breakdown: 'audience' as const },
  { count: 30, breakdown: 'technology' as const },
  { count: 101, breakdown: 'audience' as const },
  { count: 101, breakdown: 'technology' as const },
  { count: 8, breakdown: 'audience' as const, source: 'google.com' },
  { count: 8, breakdown: 'technology' as const, source: 'google.com' },
  { count: 101, breakdown: 'technology' as const, source: 'google.com' },
])('preserves immediate calls and scoped report metrics for %j', async ({ count, ...extra }) => {
  setup(count);
  mode = 'normal';
  const pending = report(extra);
  const initial = expectedDispatches(extra);
  const calls =
    extra.breakdown === 'acquisition'
      ? 12
      : count > 100
        ? extra.source
          ? 9
          : 11
        : extra.source
          ? 4
          : 6;
  const response = await pending;
  expect(response.status).toBe(200);
  expect(queries).toHaveLength(calls);
  expect(dispatchesAtFirstHeaders).toBe(initial.length);
  expect(dispatches.slice(0, initial.length)).toEqual(initial);
  expect(dispatches).toHaveLength(calls);
  expect(new Set(dispatches).size).toBe(calls);
  expect(peakWaitingHeaders).toBeLessThanOrEqual(6);
  expect(peakWaitingHeaders).toBeGreaterThanOrEqual(Math.min(6, initial.length));
  for (const sql of queries) {
    expect(sql).toContain(`index1 = '${workspace}'`);
    expect(sql).toContain(`blob1 = '${scope.app_id}'`);
    expect(sql).toContain(`blob2 = '${scope.environment_id}'`);
  }
  const body = (await response.json()) as {
    series: Array<{ pageviews: number }>;
    engagement?: unknown;
  };
  expect(body.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(count);
  expect(body.engagement !== undefined).toBe(!extra.source);
  expect(response.headers.get('server-timing')?.includes('analytics_joint_attempts')).toBe(
    extra.breakdown !== 'acquisition',
  );
});

it('retains body and inflight isolation from public315 and four earlier cache plans with60second TTL', async () => {
  setup();
  mode = 'normal';
  cacheEnabled = true;
  const releases: Array<() => void> = [];
  const keys = [
    JSON.stringify([filter(), [scope.app_id]]),
    ...[
      'pages-watchdog-v1',
      'trend-pages-watchdog-v2',
      'optional-first-v3',
      'eager-bounded-v4',
    ].map((plan) => JSON.stringify(['browser-report:' + plan, filter(), [scope.app_id]])),
  ];
  const pending = keys.map((key) =>
    snapshotCachedAnalytics(
      env.DB,
      env.CLOUDFLARE_ACCOUNT_ID!,
      workspace,
      key,
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ unpromoted_marker: true }));
        }),
    ),
  );
  await vi.waitFor(() => expect(releases).toHaveLength(5));
  const first = await report();
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(queries).toHaveLength(6);
  releases.forEach((release) => release());
  await Promise.all(pending);
  const second = await report();
  expect(observable(await second.json())).toEqual(observable(body));
  expect(queries).toHaveLength(6);
  expect(
    [...entries.keys()].filter((key) =>
      decodeURIComponent(key).includes('browser-report:page-control-bounded-v5'),
    ),
  ).toHaveLength(1);
  expect(new Set(ttl)).toEqual(new Set(['max-age=60']));
  expect(second.headers.get('server-timing')).not.toContain('analytics_query_wait');
});

it('isolates optional provider failures without retrying or discarding core metrics', async () => {
  setup();
  mode = 'optional-failure';
  const response = await report();
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    engagement?: unknown;
    series: Array<{ pageviews: number }>;
  };
  expect(body.engagement).toBeUndefined();
  expect(body.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(8);
  expect(dispatches).toHaveLength(6);
});

it.each(['core-headers', 'core-body'])(
  'retains one shared provider deadline for %s',
  async (failure) => {
    setup();
    mode = failure;
    const started = performance.now();
    const response = await report();
    expect(response.status).toBe(503);
    expect(dispatches).toHaveLength(6);
    expect(performance.now() - started).toBeLessThan(13000);
  },
  18000,
);

it('rejects unauthenticated and foreign scopes before starting provider work', async () => {
  setup();
  mode = 'normal';
  expect(
    (await request('/v1/analytics/report?' + new URLSearchParams(filter()), undefined, false))
      .status,
  ).toBe(401);
  expect(
    (await request('/v1/analytics/report?range=24h&app_id=foreign&environment_id=foreign')).status,
  ).toBe(403);
  expect(dispatches).toHaveLength(0);
});

it.each(['joint-http', 'joint-bodycap'])(
  'recovers from real HTTP speculative %s without discarding report data',
  async (failure) => {
    setup(30);
    mode = failure;
    const response = await report();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      series: Array<{ pageviews: number }>;
      engagement?: unknown;
    };
    expect(body.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(30);
    expect(body.engagement).toBeDefined();
    expect(dispatches).toHaveLength(11);
    expect(queries).toHaveLength(11);
    expect(dispatches.filter((sql) => sql.includes('GROUP BY event_kind'))).toHaveLength(1);
    expect(response.headers.get('server-timing')).toContain('analytics_joint_fallbacks;desc="1"');
    if (failure === 'joint-bodycap') await vi.waitFor(() => expect(speculativeClosed).toBe(true));
  },
);
