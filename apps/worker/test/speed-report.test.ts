import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DailySpeedSectionV1,
  DailyEngagementReportV1,
  DailyEngagementProductReportV1,
  PortfolioBriefingV1,
  SpeedReportV1,
} from '@app-health/contracts';
import {
  readSpeedReport,
  readSpeedReportParts,
  summarizeSpeedForDay,
} from '../src/speed-report.js';
import * as dailyEngagement from '../src/daily-engagement-report.js';
import * as portfolioBriefing from '../src/portfolio-briefing.js';
import worker, { type Env } from '../src/index.js';
import { LocalOwnerIdentityAdapter, type OwnerIdentity } from '../src/identity.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

const NOW = Date.UTC(2026, 9, 10, 12);
const WINDOW = 15 * 60_000;
const DAY = {
  date: '2026-10-09',
  from: Date.UTC(2026, 9, 8, 18, 30),
  to: Date.UTC(2026, 9, 9, 18, 30),
};
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE catalog_project_imports
      (workspace_id TEXT, catalog_id TEXT, catalog_name TEXT, app_id TEXT, lifecycle TEXT);
    CREATE TABLE environments (id TEXT PRIMARY KEY, app_id TEXT, name TEXT);
    CREATE TABLE log_events
      (app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, level TEXT, props TEXT,
       source TEXT NOT NULL DEFAULT 'server');
    CREATE TABLE apps (id TEXT PRIMARY KEY, archived_at INTEGER);
    CREATE INDEX idx_log_events_event_time ON log_events (event, timestamp);
    INSERT INTO catalog_project_imports VALUES
      ('ws-one', 'alpha', 'Alpha', 'app-a', 'primary'),
      ('ws-one', 'beta', 'Beta', 'app-b', 'active'),
      ('ws-one', 'retired', 'Retired', 'app-retired', 'retired'),
      ('ws-one', 'staging', 'Staging only', 'app-staging', 'active'),
      ('ws-one', 'archived', 'Archived', 'app-archived', 'active'),
      ('ws-two', 'other', 'Other', 'app-other', 'active');
    INSERT INTO apps VALUES
      ('app-a', NULL), ('app-b', NULL), ('app-retired', NULL), ('app-staging', NULL),
      ('app-other', NULL), ('app-archived', 1);
    INSERT INTO environments VALUES
      ('env-a', 'app-a', 'Production'), ('env-b', 'app-b', 'production'),
      ('env-a-stage', 'app-a', 'staging'), ('env-retired', 'app-retired', 'production'),
      ('env-staging', 'app-staging', 'staging'), ('env-other', 'app-other', 'production'),
      ('env-archived', 'app-archived', 'production');
  `);
  const queries: { sql: string; values: unknown[] }[] = [];
  const db: D1DatabaseLike = {
    prepare(sql) {
      let values: unknown[] = [];
      const statement: D1PreparedStatement = {
        bind(...args) {
          values = args;
          return statement;
        },
        async all<T>() {
          queries.push({ sql, values });
          return { results: sqlite.prepare(sql).all(...(values as SQLInputValue[])) as T[] };
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...(values as SQLInputValue[])) ?? null) as T | null;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...(values as SQLInputValue[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
  const insert = sqlite.prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?, ?, ?)');
  function log(
    event: string,
    props: unknown,
    options: {
      app?: string;
      environment?: string;
      timestamp?: number;
      level?: string;
      source?: string;
    } = {},
  ) {
    insert.run(
      options.app ?? 'app-a',
      options.environment ?? 'env-a',
      options.timestamp ?? NOW - 1,
      event,
      options.level ?? 'debug',
      typeof props === 'string' ? props : JSON.stringify(props),
      options.source ?? (event === 'web.vitals' ? 'browser' : 'server'),
    );
  }
  const args = (overrides: Partial<Parameters<typeof readSpeedReport>[0]> = {}) => ({
    db,
    workspaceId: 'ws-one',
    range: '24h' as const,
    now: NOW,
    performanceClass: 'app' as const,
    ...overrides,
  });
  const read = (overrides: Partial<Parameters<typeof readSpeedReport>[0]> = {}) =>
    readSpeedReport(args(overrides));
  const parts = (overrides: Partial<Parameters<typeof readSpeedReport>[0]> = {}) =>
    readSpeedReportParts(args(overrides));
  return { sqlite, db, queries, log, read, parts };
}

function stage(overrides: Record<string, unknown> = {}) {
  return {
    route: '/api/articles/:id',
    status: 200,
    total_ms: 100,
    edge_cache: 'NONE',
    inner_cache: 'HIT',
    ...overrides,
  };
}
function vital(overrides: Record<string, unknown> = {}) {
  return { route_group: '/articles', nav_type: 'navigate', lcp_ms: 1000, ...overrides };
}

describe('readSpeedReport', () => {
  it('computes nearest-rank percentiles, template groups, errors and stages from sampled rows', async () => {
    const f = fixture();
    for (let i = 1; i <= 100; i++) {
      f.log('api.stage_timing', stage({ total_ms: i, db_ms: i * 2, status: i <= 5 ? 503 : 200 }));
      f.log('web.vitals', vital({ lcp_ms: i, inp_ms: i * 2, ttfb_ms: i * 3, cls_milli: i }));
    }
    const report = await f.read();
    expect(SpeedReportV1.parse(report)).toEqual(report);
    expect(report.products[0].server.routes).toHaveLength(1);
    expect(report.products[0].server.routes[0]).toMatchObject({
      route: '/api/articles/:id',
      samples: 100,
      error_rate: 0.05,
      total_ms: { p50: 50, p95: 95, p99: 99 },
      stages_p95_ms: { db_ms: 190 },
      cache: { NONE: 100, HIT: 0, hit_ratio: null },
    });
    expect(report.products[0].vitals.routes[0]).toMatchObject({
      samples: 100,
      lcp_ms: { p75: 75 },
      inp_ms: { p75: 150 },
      ttfb_ms: { p75: 225 },
      cls_milli: { p75: 75 },
      breaches: [],
    });
    expect(report.summary).toEqual({ measured: 1, no_data: 1, insufficient: 0, breaching: 0 });
  });

  it('rejects invalid JSON and props without returning private fields', async () => {
    const f = fixture();
    for (const props of [
      '{broken',
      stage({ route: '/api/articles/123' }),
      stage({ email: 'private' }),
    ])
      f.log('api.stage_timing', props);
    for (const props of [vital({ route_group: '/123' }), vital({ lcp_ms: -1 }), null])
      f.log('web.vitals', props);
    f.log('api.stage_timing', stage({ cold: 1, release: 'v1', db_ms: 0 }));
    const product = (await f.read()).products[0];
    expect(product).toMatchObject({
      rejected: 6,
      state: 'insufficient',
      server: { samples: 1 },
      vitals: { samples: 0 },
    });
    expect(JSON.stringify(product)).not.toMatch(/private|release|cold|inner_cache/);
  });

  it('never breaches under the route or individual metric sample minimum', async () => {
    const f = fixture();
    for (let i = 0; i < 29; i++) f.log('api.stage_timing', stage({ total_ms: 600_000 }));
    for (let i = 0; i < 49; i++) f.log('web.vitals', vital({ lcp_ms: 600_000 }));
    let product = (await f.read()).products[0];
    expect(product.state).toBe('insufficient');
    for (const route of [...product.server.routes, ...product.vitals.routes])
      expect(route).toMatchObject({ breaches: [], sustained: 'insufficient' });
    f.log('web.vitals', { route_group: '/articles', nav_type: 'reload', inp_ms: 0 });
    product = (await f.read()).products[0];
    expect(product.state).toBe('insufficient');
    expect(product.vitals.routes[0]).toMatchObject({ samples: 50, breaches: [] });
    f.log('api.stage_timing', stage({ total_ms: 600_000 }));
    f.log('web.vitals', vital({ lcp_ms: 600_000 }));
    product = (await f.read()).products[0];
    expect(product.state).toBe('measured');
    expect(product.server.routes[0].breaches).toHaveLength(3);
    expect(product.vitals.routes[0].breaches).toEqual([
      { metric: 'lcp_ms', value: 600_000, budget: 2500 },
    ]);
  });

  it.each([
    { windows: [true, false, true, true], expected: 'breach' },
    { windows: [false, false, true, false], expected: 'insufficient' },
    { windows: [false, false, false, false], expected: 'ok' },
  ])('evaluates the most recent four windows: $expected', async ({ windows, expected }) => {
    const f = fixture();
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 30; i++) {
        const timestamp = NOW - (4 - w) * WINDOW;
        f.log('api.stage_timing', stage({ total_ms: windows[w] ? 501 : 500 }), { timestamp });
        f.log('web.vitals', vital({ lcp_ms: windows[w] ? 2501 : 2500 }), { timestamp });
      }
    }
    // Old spikes and future timestamps cannot influence the latest windows.
    for (let i = 0; i < 90; i++) {
      f.log('api.stage_timing', stage({ total_ms: 600_000 }), { timestamp: NOW - 5 * WINDOW });
      f.log('web.vitals', vital({ lcp_ms: 600_000 }), { timestamp: NOW - 5 * WINDOW });
    }
    f.log('api.stage_timing', stage({ total_ms: 600_000 }), { timestamp: NOW });
    const product = (await f.read()).products[0];
    expect(product.server.routes[0].sustained).toBe(expected);
    expect(product.vitals.routes[0].sustained).toBe(expected);
    expect(product.server.samples).toBe(210);
  });

  it('uses per-window sample counts and LCP only for sustained vitals', async () => {
    const f = fixture();
    for (let w = 0; w < 4; w++)
      for (let i = 0; i < 29; i++) {
        const timestamp = NOW - (4 - w) * WINDOW;
        f.log('api.stage_timing', stage({ total_ms: 1000 }), { timestamp });
        f.log(
          'web.vitals',
          { route_group: '/', nav_type: 'navigate', inp_ms: 1000 },
          { timestamp },
        );
      }
    const product = (await f.read()).products[0];
    expect(product.server.routes[0].sustained).toBe('insufficient');
    expect(product.vitals.routes[0]).toMatchObject({ lcp_ms: null, sustained: 'insufficient' });
  });

  it('uses the selected web class and API read server budgets for every class', async () => {
    const f = fixture();
    for (let i = 0; i < 50; i++) {
      f.log('web.vitals', vital({ lcp_ms: 2200 }));
      f.log('api.stage_timing', stage({ total_ms: 501 }));
    }
    expect((await f.read()).products[0].vitals.routes[0].breaches).toEqual([]);
    const landing = await f.read({ performanceClass: 'landing' });
    expect(landing.products[0].vitals.routes[0].breaches[0].budget).toBe(2000);
    const api = await f.read({ performanceClass: 'api' });
    expect(api.budgets.vitals).toBeNull();
    expect(api.products[0].vitals.routes[0].breaches).toEqual([]);
    expect(api.products[0].server.routes[0].breaches).toContainEqual({
      metric: 'total_ms.p95',
      value: 501,
      budget: 500,
    });
  });

  it('counts edge-cache outcomes and ranks the top five colos', async () => {
    const f = fixture();
    const caches = ['HIT', 'MISS', 'EXPIRED', 'BYPASS', 'DYNAMIC', 'STALE', 'REVALIDATED', 'NONE'];
    for (let i = 0; i < caches.length; i++)
      f.log('api.stage_timing', stage({ edge_cache: caches[i] }));
    let route = (await f.read()).products[0].server.routes[0];
    for (const cache of caches) expect(route.cache[cache as keyof typeof route.cache]).toBe(1);
    expect(route.cache.hit_ratio).toBe(1 / 7);
    for (let c = 0; c < 6; c++)
      for (let i = 0; i < c + 10; i++)
        f.log('api.stage_timing', stage({ colo: `C${c}`, total_ms: i }));
    route = (await f.read()).products[0].server.routes[0];
    expect(route.colos.map((c) => c.colo)).toEqual(['C5', 'C4', 'C3', 'C2', 'C1']);
    expect(route.colos[0]).toEqual({ colo: 'C5', samples: 15, p95_ms: 14 });
  });

  it('scopes indexed reads to the workspace catalog, production, debug level and time range', async () => {
    const f = fixture();
    for (const event of ['api.stage_timing', 'web.vitals']) {
      const props = event === 'web.vitals' ? vital() : stage();
      f.log(event, props);
      f.log(event, props, { app: 'app-other', environment: 'env-other' });
      f.log(event, props, { app: 'app-retired', environment: 'env-retired' });
      f.log(event, props, { app: 'app-staging', environment: 'env-staging' });
      f.log(event, props, { environment: 'env-a-stage' });
      f.log(event, props, { level: 'info' });
      f.log(event, props, { timestamp: NOW - 3_600_001 });
    }
    const report = await f.read({ range: '1h' });
    expect(report.products.map((p) => p.app_id)).toEqual(['app-a', 'app-b']);
    expect(report.products[0]).toMatchObject({ server: { samples: 1 }, vitals: { samples: 1 } });
    expect(f.queries).toHaveLength(3); // catalog plus exactly two event reads
    for (const { sql, values } of f.queries.slice(1)) {
      const plan = f.sqlite
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(values as SQLInputValue[]));
      expect(JSON.stringify(plan)).toContain(
        'idx_log_events_event_time (event=? AND timestamp>? AND timestamp<?)',
      );
      expect(sql).toContain('ORDER BY l.timestamp DESC LIMIT 20000');
    }
    expect((await f.read({ appId: 'app-other' })).products).toEqual([]);
    expect((await f.read({ appId: 'app-b' })).products[0].state).toBe('no_data');
  });

  it.each(['api.stage_timing', 'web.vitals'])(
    'marks truncation when %s reaches the hard limit',
    async (event) => {
      const f = fixture();
      f.sqlite.exec('BEGIN');
      for (let i = 0; i < 20_001; i++)
        f.log(event, event === 'web.vitals' ? vital({ lcp_ms: i }) : stage({ total_ms: i }), {
          timestamp: NOW - i - 1,
        });
      f.sqlite.exec('COMMIT');
      const report = await f.read();
      const field = event === 'web.vitals' ? 'vitals' : 'server';
      expect(report.products[0][field]).toMatchObject({ samples: 20_000, truncated: true });
      expect(report.products[1][field].truncated).toBe(true);
      if (field === 'server') expect(report.products[0].server.routes[0].total_ms.p99).toBe(19_799);
      else expect(report.products[0].vitals.routes[0].lcp_ms?.p75).toBe(14_999);
    },
  );

  it('trusts stage timings only from server logs and web vitals only from browser logs', async () => {
    const f = fixture();
    f.log('api.stage_timing', stage(), { source: 'browser' });
    f.log('web.vitals', vital(), { source: 'server' });
    f.log('api.stage_timing', stage());
    f.log('web.vitals', vital());
    const report = await f.read();
    expect(report.products[0]).toMatchObject({ server: { samples: 1 }, vitals: { samples: 1 } });
    for (const { sql } of f.queries.slice(1)) expect(sql).toContain('l.source = ?');
  });

  it('excludes archived apps from the catalog, including explicit app filters', async () => {
    const f = fixture();
    f.log('api.stage_timing', stage(), { app: 'app-archived', environment: 'env-archived' });
    const report = await f.read();
    expect(report.products.map((p) => p.app_id)).toEqual(['app-a', 'app-b']);
    expect((await f.read({ appId: 'app-archived' })).products).toEqual([]);
  });

  it('keeps a breaching route and its summary even when it is outside the busiest 25', async () => {
    const f = fixture();
    for (let r = 0; r < 25; r++)
      for (let i = 0; i < 31; i++) f.log('api.stage_timing', stage({ route: `/api/ok-${r}` }));
    for (let i = 0; i < 30; i++)
      f.log('api.stage_timing', stage({ route: '/api/slow', total_ms: 5000 }));
    const report = await f.read();
    expect(report.products[0].server.routes).toHaveLength(25);
    expect(report.products[0].server.routes[0].route).toBe('/api/slow');
    expect(report.summary.breaching).toBe(1);
  });

  it('caps products and each event to the busiest 25 routes', async () => {
    const f = fixture();
    const catalog = f.sqlite.prepare('INSERT INTO catalog_project_imports VALUES (?, ?, ?, ?, ?)');
    const env = f.sqlite.prepare('INSERT INTO environments VALUES (?, ?, ?)');
    const app = f.sqlite.prepare('INSERT INTO apps VALUES (?, NULL)');
    for (let i = 0; i < 60; i++) {
      app.run(`app-${i}`);
      catalog.run('ws-one', `extra-${i}`, `Extra ${i}`, `app-${i}`, 'active');
      env.run(`env-${i}`, `app-${i}`, 'production');
    }
    for (let r = 0; r < 27; r++)
      for (let i = 0; i <= r; i++) {
        f.log('api.stage_timing', stage({ route: `/api/route-${r}/:id` }));
        f.log('web.vitals', vital({ route_group: `/route-${r}` }));
      }
    const report = await f.read();
    expect(report.products).toHaveLength(56);
    for (const field of ['vitals', 'server'] as const) {
      expect(report.products[0][field].routes).toHaveLength(25);
      expect(report.products[0][field].routes[0].samples).toBe(27);
      expect(report.products[0][field].routes[24].samples).toBe(3);
    }
  });
});

describe('GET /v1/reports/speed', () => {
  function setup(
    owner: OwnerIdentity | null = { id: 'owner', label: 'Owner', workspaceId: 'ws-one' },
  ) {
    const f = fixture();
    vi.spyOn(LocalOwnerIdentityAdapter.prototype, 'resolve').mockReturnValue(owner);
    const env: Env = { APP_HEALTH_MODE: 'local', DB: f.db };
    const request = (query = '', method = 'GET') =>
      worker.fetch(new Request(`http://localhost/v1/reports/speed${query}`, { method }), env);
    return { ...f, env, request };
  }

  it('authenticates owners and forbids product or missing workspace scopes', async () => {
    const f = setup(null);
    expect((await f.request()).status).toBe(403);
    for (const owner of [
      { id: 'owner', label: 'Owner' },
      { id: 'product', label: 'Product', workspaceId: 'ws-one', appId: 'app-a' },
    ]) {
      vi.mocked(LocalOwnerIdentityAdapter.prototype.resolve).mockReturnValue(owner);
      const response = await f.request();
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.queries).toHaveLength(0);
  });

  it('rejects non-GET, invalid queries and unavailable storage before any read', async () => {
    const f = setup();
    expect((await f.request('', 'POST')).status).toBe(405);
    for (const query of ['?range=2h', '?class=job', '?app_id=', '?unknown=true'])
      expect((await f.request(query)).status).toBe(400);
    delete f.env.DB;
    expect((await f.request()).status).toBe(503);
    expect(f.queries).toHaveLength(0);
  });

  it('serves no-store JSON and caches for 60 seconds separately by range, class, app and workspace', async () => {
    const f = setup();
    const entries = new Map<string, Response>();
    const put = vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    });
    vi.stubGlobal('caches', {
      default: {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put,
      },
    });
    let response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(SpeedReportV1.parse(await response.json()).summary.no_data).toBe(2);
    await f.request('?range=24h&class=app');
    expect(f.queries).toHaveLength(3);
    for (const query of ['?range=1h', '?class=landing', '?app_id=app-b']) {
      response = await f.request(query);
      expect(response.status).toBe(200);
    }
    vi.mocked(LocalOwnerIdentityAdapter.prototype.resolve).mockReturnValue({
      id: 'other',
      label: 'Other',
      workspaceId: 'ws-two',
    });
    response = await f.request();
    expect(SpeedReportV1.parse(await response.json()).products.map((p) => p.app_id)).toEqual([
      'app-other',
    ]);
    expect(put).toHaveBeenCalledTimes(5);
    for (const [, cached] of put.mock.calls)
      expect(cached.headers.get('cache-control')).toBe('max-age=60');
  });

  it('fails closed with a sanitized error when the database read fails', async () => {
    const f = setup();
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('catalog_project_imports')) throw new Error('private query');
      return prepare(sql);
    });
    const response = await f.request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'speed report is unavailable' });
  });
});

describe('daily speed aggregates', () => {
  it('computes nearest rank independently for each product metric across uneven route groups', async () => {
    const f = fixture();
    for (let i = 1; i <= 100; i++) {
      f.log(
        'api.stage_timing',
        stage({
          route: `/api/group-${i % 26}`,
          total_ms: i,
          status: i <= 5 ? 503 : 200,
          edge_cache: i <= 50 ? 'HIT' : i <= 75 ? 'MISS' : 'NONE',
        }),
        { timestamp: DAY.from },
      );
      f.log(
        'web.vitals',
        vital({
          route_group: `/group-${i % 26}`,
          lcp_ms: i,
          inp_ms: i * 2,
          ttfb_ms: i * 3,
          cls_milli: i,
        }),
        { timestamp: DAY.from },
      );
    }
    const parts = await f.parts({ window: DAY });
    const report = parts.report;
    expect(report.products[0].vitals.routes).toHaveLength(25);
    expect(summarizeSpeedForDay(parts, DAY).products[0]).toMatchObject({
      vitals_samples: 100,
      lcp_p75_ms: 75,
      inp_p75_ms: 150,
      cls_p75_milli: 75,
      ttfb_p75_ms: 225,
      server_samples: 100,
      server_p50_ms: 50,
      server_p95_ms: 95,
      server_p99_ms: 99,
      error_rate: 0.05,
      cache_hit_ratio: 2 / 3,
      state: 'insufficient',
      breaching_routes: 0,
      worst_route: null,
    });
  });

  it('uses all retained samples and every breaching route, including routes outside the display cap', async () => {
    const f = fixture();
    for (let r = 0; r < 26; r++) {
      const last = r === 25;
      for (let i = 0; i < 30; i++)
        f.log(
          'api.stage_timing',
          stage({
            route: last ? '/api/route-z' : `/api/route-${r}`,
            total_ms: last ? 6000 : 1000,
            status: last ? 503 : 200,
            edge_cache: last ? 'NONE' : 'HIT',
          }),
          { timestamp: DAY.from },
        );
      for (let i = 0; i < 50; i++)
        f.log(
          'web.vitals',
          vital({
            route_group: last ? '/route-z' : `/route-${r}`,
            lcp_ms: last ? 20_000 : 3000,
            ...(last ? { inp_ms: 10_000 } : {}),
          }),
          { timestamp: DAY.to - 1 },
        );
    }
    const parts = await f.parts({ window: DAY });
    const product = parts.report.products[0];
    expect(product.server.routes).toHaveLength(25);
    expect(product.vitals.routes).toHaveLength(25);
    expect(product.server.routes.some((route) => route.route === '/api/route-z')).toBe(false);
    expect(product.vitals.routes.some((route) => route.route_group === '/route-z')).toBe(false);
    const daily = summarizeSpeedForDay(parts, DAY);
    expect(DailySpeedSectionV1.parse(daily)).toEqual(daily);
    expect(daily.products[0]).toEqual({
      catalog_id: 'alpha',
      app_id: 'app-a',
      state: 'measured',
      vitals_samples: 1300,
      lcp_p75_ms: 3000,
      inp_p75_ms: 10_000,
      cls_p75_milli: null,
      ttfb_p75_ms: null,
      server_samples: 780,
      server_p50_ms: 1000,
      server_p95_ms: 1000,
      server_p99_ms: 6000,
      error_rate: 1 / 26,
      cache_hit_ratio: 1,
      breaching_routes: 52,
      worst_route: '/route-z',
    });
    expect(daily.summary).toEqual({ measured: 1, no_data: 1, insufficient: 0, breaching: 1 });
    expect(daily.truncated).toBe(false);
  });

  it('keeps absent metrics null and distinguishes no data from insufficient samples', async () => {
    const f = fixture();
    let daily = summarizeSpeedForDay(await f.parts({ window: DAY }), DAY);
    expect(daily.summary.no_data).toBe(2);
    expect(daily.products[0]).toMatchObject({
      state: 'no_data',
      lcp_p75_ms: null,
      server_p50_ms: null,
      server_p95_ms: null,
      server_p99_ms: null,
      error_rate: null,
      cache_hit_ratio: null,
      worst_route: null,
      breaching_routes: 0,
    });
    f.log(
      'web.vitals',
      { route_group: '/', nav_type: 'navigate', cls_milli: 0 },
      { timestamp: DAY.from },
    );
    f.log('api.stage_timing', stage({ total_ms: 600_000 }), { timestamp: DAY.from });
    daily = summarizeSpeedForDay(await f.parts({ window: DAY }), DAY);
    expect(daily.summary).toEqual({ measured: 0, no_data: 1, insufficient: 1, breaching: 0 });
    expect(daily.products[0]).toMatchObject({
      state: 'insufficient',
      cls_p75_milli: 0,
      lcp_p75_ms: null,
      server_p95_ms: 600_000,
      breaching_routes: 0,
      worst_route: null,
    });
  });

  it('uses the explicit half-open day window instead of range and never computes sustained day states', async () => {
    const f = fixture();
    for (const timestamp of [DAY.from - 1, DAY.from, DAY.to - 1, DAY.to, NOW - 1]) {
      const inside = timestamp >= DAY.from && timestamp < DAY.to;
      f.log('api.stage_timing', stage({ total_ms: inside ? 100 : 600_000 }), { timestamp });
      f.log('web.vitals', vital({ lcp_ms: inside ? 1000 : 600_000 }), { timestamp });
    }
    // Enough samples in each of the latest hour's windows would otherwise establish ok.
    for (let w = 0; w < 4; w++)
      for (let i = 0; i < 30; i++) {
        const timestamp = DAY.to - (4 - w) * WINDOW;
        f.log('api.stage_timing', stage(), { timestamp });
        f.log('web.vitals', vital(), { timestamp });
      }
    const parts = await f.parts({ range: '1h', window: DAY, now: DAY.to });
    const report = parts.report;
    for (const field of ['server', 'vitals'] as const) {
      expect(report.products[0][field].samples).toBe(122);
      expect(report.products[0][field].routes[0].sustained).toBe('insufficient');
    }
    expect(summarizeSpeedForDay(parts, DAY).products[0]).toMatchObject({
      lcp_p75_ms: 1000,
      server_p95_ms: 100,
    });
  });

  it('propagates retained-log truncation even to products without samples', async () => {
    const f = fixture();
    f.sqlite.exec('BEGIN');
    for (let i = 0; i < 20_000; i++) f.log('web.vitals', vital(), { timestamp: DAY.from });
    f.sqlite.exec('COMMIT');
    const daily = summarizeSpeedForDay(await f.parts({ window: DAY }), DAY);
    expect(daily.truncated).toBe(true);
    expect(daily.products[1].state).toBe('no_data');
  });
});

describe('daily engagement speed opt-in', () => {
  function setup() {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(LocalOwnerIdentityAdapter.prototype, 'resolve').mockReturnValue({
      id: 'owner',
      label: 'Owner',
      workspaceId: 'ws-one',
    });
    const report = DailyEngagementReportV1.parse({
      schema: 'app-health.daily-engagement.v1',
      schema_version: 1,
      generated_at: NOW,
      ...DAY,
      timezone: 'Asia/Kolkata',
      product_count: 1,
      products: [
        DailyEngagementProductReportV1.parse({
          catalog_id: 'alpha',
          app_id: 'app-a',
          name: 'Alpha',
          browser_visitors: null,
          cta_events: [],
          cta_status: 'unknown',
          feedback_submitted: null,
          newsletter_joins: null,
          waitlist_joins: null,
          native_sessions: null,
          api_activity: null,
          freshness: { browser_last_seen: null, log_last_seen: null },
          coverage: 'unknown',
        }),
      ],
      sampled: false,
      notes: [],
    });
    // Isolate the route extension; the unchanged daily composer has its own grouped log reads.
    const compose = vi
      .spyOn(dailyEngagement, 'composeDailyEngagementReport')
      .mockResolvedValue(report);
    const env: Env = { APP_HEALTH_MODE: 'local', DB: f.db };
    const request = (query = '', path = 'daily-engagement') =>
      worker.fetch(new Request(`http://localhost/v1/reports/${path}${query}`), env);
    return {
      ...f,
      env,
      request,
      report: dailyEngagement.dailyEngagementClientPayload(report, false),
      compose,
    };
  }

  it('keeps the original response bytes and does not read speed logs without speed=1', async () => {
    const f = setup();
    for (const query of ['', '?speed=0', '?speed=true', '?speed_class=job']) {
      const response = await f.request(query);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(JSON.stringify(f.report));
    }
    expect(f.queries).toEqual([]);
  });

  it('uses the report day, default class and a separate day/class cache', async () => {
    const f = setup();
    f.log('api.stage_timing', stage({ total_ms: 123 }), { timestamp: DAY.from });
    f.log('api.stage_timing', stage({ total_ms: 600_000 }), { timestamp: DAY.to });
    const entries = new Map<string, Response>();
    const put = vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    });
    vi.stubGlobal('caches', {
      default: {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put,
      },
    });
    let response = await f.request('?speed=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { speed, ...payload } = (await response.json()) as { speed: DailySpeedSectionV1 };
    expect(payload).toEqual(f.report);
    expect(speed).toMatchObject({ ...DAY, class: 'app' });
    expect(speed.products[0]).toMatchObject({ server_samples: 1, server_p95_ms: 123 });
    await f.request('?speed=1&speed_class=app');
    expect(f.queries).toHaveLength(3);
    for (const performanceClass of ['landing', 'api']) {
      response = await f.request(`?speed=1&speed_class=${performanceClass}`);
      expect(((await response.json()) as { speed: DailySpeedSectionV1 }).speed.class).toBe(
        performanceClass,
      );
    }
    await f.request('?speed=1&date=2026-10-08');
    const keys = [...entries.keys()].map((key) => new URL(key).searchParams.get('query'));
    expect(keys).toEqual(
      expect.arrayContaining([
        'daily-speed-v1:2026-10-09:app',
        'daily-speed-v1:2026-10-09:landing',
        'daily-speed-v1:2026-10-09:api',
        'daily-speed-v1:2026-10-08:app',
      ]),
    );
    for (const [, cached] of put.mock.calls)
      expect(cached.headers.get('cache-control')).toBe('max-age=60');
  });

  it.each(['job', '', 'APP'])(
    'rejects invalid opted-in speed_class %s before reads',
    async (performanceClass) => {
      const f = setup();
      const response = await f.request(`?speed=1&speed_class=${performanceClass}`);
      expect(response.status).toBe(400);
      expect(f.compose).not.toHaveBeenCalled();
      expect(f.queries).toEqual([]);
    },
  );

  it('returns the daily report and sanitized speed_error when the speed read fails', async () => {
    const f = setup();
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('log_events')) throw new Error('private query');
      return prepare(sql);
    });
    const response = await f.request('?speed=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ...f.report, speed_error: 'unavailable' });
  });

  it('ignores speed flags on the portfolio briefing route', async () => {
    const f = setup();
    const briefing = PortfolioBriefingV1.parse({
      date: DAY.date,
      timezone: 'Asia/Kolkata',
      traffic: 'non_bot',
      generated_at: NOW,
      products: [],
      sources: [],
      comparison_note: 'Unknown',
      filter_note: 'Non-bot',
    });
    vi.spyOn(portfolioBriefing, 'readPortfolioBriefing').mockResolvedValue(briefing);
    const response = await f.request('?speed=1&speed_class=job', 'portfolio-briefing');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify(briefing));
    expect(f.queries).toEqual([]);
  });
});
