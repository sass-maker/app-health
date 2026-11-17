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
import {
  rankingFixture,
  observable,
  isJoint,
  isPages,
  isPeriods,
} from './ranking-report-fixture.js';

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
let mode = 'counter';
let queries: string[] = [];
const entries = new Map<string, Response>();
const ttl: string[] = [];
let cacheEnabled = false;
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
const report = () => request('/v1/analytics/report?' + new URLSearchParams(filter()));

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
    if (isJoint(sql) && mode === 'non-ok') {
      response.writeHead(503);
      response.end();
      return;
    }
    if (isJoint(sql) && mode === 'headers') return;
    if (isJoint(sql) && mode === 'body') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"data":');
      return;
    }
    const rows = data.database.prepare(sqliteAnalyticsSql(sql)).all();
    const send = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ data: isJoint(sql) && mode === 'late-malformed' ? null : rows }),
      );
    };
    const remainingRanking =
      !isJoint(sql) &&
      !isPages(sql) &&
      !isPeriods(sql) &&
      !sql.includes('GROUP BY bucket') &&
      !sql.includes('session_id');
    const delay =
      mode === 'late-malformed' && isJoint(sql)
        ? 9000
        : mode === 'late-malformed' && remainingRanking
          ? 5000
          : (mode === 'pages' ? isPeriods(sql) : isPages(sql))
            ? 20
            : 0;
    const timer = setTimeout(send, delay);
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
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('https://api.cloudflare.com/')
      ? originalFetch(providerOrigin, init)
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

it('compares full authenticated Worker reports through real HTTP provider transport for small and high workloads', async () => {
  for (const count of [8, 30]) {
    setup(count);
    mode = 'pages';
    const baseline = await report();
    expect(baseline.status).toBe(200);
    const body = await baseline.json();
    expect(queries).toHaveLength(10);
    queries = [];
    mode = 'counter';
    const candidate = await report();
    expect(candidate.status).toBe(200);
    expect(observable(await candidate.json())).toEqual(observable(body));
    expect(queries).toHaveLength(count <= 20 ? 6 : 10);
    expect(candidate.headers.get('server-timing')?.includes('analytics_joint;dur=')).toBe(
      count <= 20,
    );
    for (const sql of queries) {
      expect(sql).toContain(`index1 = '${workspace}'`);
      expect(sql).toContain(`blob1 = '${scope.app_id}'`);
      expect(sql).toContain(`blob2 = '${scope.environment_id}'`);
    }
    expect(
      (await request('/v1/analytics/report?' + new URLSearchParams(filter()), undefined, false))
        .status,
    ).toBe(401);
    expect(
      (await request('/v1/analytics/report?range=24h&app_id=foreign&environment_id=foreign'))
        .status,
    ).toBe(403);
  }
}, 15_000);

it('separates candidate cache and in-flight bodies from original-plan entries while keeping 60-second reuse', async () => {
  setup();
  mode = 'counter';
  cacheEnabled = true;
  let release!: (value: unknown) => void;
  const pending = snapshotCachedAnalytics(
    env.DB,
    env.CLOUDFLARE_ACCOUNT_ID!,
    workspace,
    JSON.stringify([filter(), [scope.app_id]]),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const first = await report();
  expect(first.status).toBe(200);
  const body = await first.json();
  expect(queries).toHaveLength(6);
  release({ original_marker: true });
  await pending;
  const repeated = await report();
  expect(await repeated.json()).toEqual(body);
  expect(queries).toHaveLength(6);
  expect(
    [...entries.keys()].filter((key) =>
      decodeURIComponent(key).includes('browser-report:pages-watchdog-v1'),
    ),
  ).toHaveLength(1);
  expect(new Set(ttl)).toEqual(new Set(['max-age=60']));
  expect(repeated.headers.get('server-timing')).not.toContain('analytics_joint;dur=');
});

it('does not retry a non-OK joint provider response', async () => {
  setup();
  mode = 'non-ok';
  const response = await report();
  expect(response.status).toBe(503);
  expect(queries).toHaveLength(6);
});

it.each(['headers', 'body', 'late-malformed'])(
  'uses one original provider deadline across %s and fallback bodies',
  async (failure) => {
    setup();
    mode = failure;
    const started = performance.now();
    const response = await report();
    expect(response.status).toBe(503);
    expect(queries).toHaveLength(failure === 'late-malformed' ? 11 : 6);
    expect(performance.now() - started).toBeLessThan(13_000);
  },
  18_000,
);
