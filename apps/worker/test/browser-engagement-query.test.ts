import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserReportPlan } from '../src/browser-report-plan.js';
import { reportWindow } from '../src/browser-report-window.js';
import { useOptionalEngagement, optionalEngagementSql } from '../src/browser-engagement-plan.js';
import { queryBrowserReport } from '../src/browser-report-query.js';
import { handleBrowserOwner } from '../src/browser-routes.js';
import { withOwnerServerTiming, type OwnerRequestTimings } from '../src/accounts.js';
import {
  engagementNow,
  engagementScope,
  optionalFixture,
  runOptionalFixture,
  isCombinedEngagement,
  type OptionalOverride,
} from './optional-engagement-fixture.js';
import type { BrowserReportFilter } from '@app-health/contracts';

let fixture: ReturnType<typeof optionalFixture>;
beforeEach(() => {
  fixture = optionalFixture();
  vi.spyOn(Date, 'now').mockReturnValue(engagementNow);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fixture.database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function pair(filter: BrowserReportFilter = engagementScope, override?: OptionalOverride) {
  const original = await runOptionalFixture(fixture, false, filter, override);
  const candidate = await runOptionalFixture(fixture, true, filter, override);
  expect(candidate.report).toEqual(original.report);
  return candidate;
}
it.each([
  engagementScope,
  { ...engagementScope, range: '1h' as const },
  { ...engagementScope, date: '2026-11-12' },
  { ...engagementScope, breakdown: 'audience' as const },
])('accepts exact default/recent/date metrics with nine calls for %j', async (filter) => {
  fixture.seed();
  fixture.add({
    blob3: 'event',
    blob5: 'opened',
    blob7: 's0',
    blob4: '/later-event',
    double2: engagementNow - 10,
  });
  fixture.add({ blob3: 'event', blob5: 'opened', blob7: 'event-only' });
  fixture.add({ blob3: 'native_session', blob7: 's1', double2: engagementNow - 5 });
  const candidate = await pair(filter);
  expect(candidate.queries).toHaveLength(9);
  expect(candidate.timings.analyticsOptionalAttempts).toBe(1);
  expect(candidate.timings.analyticsOptionalFallbacks).toBeUndefined();
  expect(candidate.timings.analyticsEngagementExitsMs).toBeGreaterThanOrEqual(0);
  expect(candidate.timings.analyticsEngagementMs).toBeUndefined();
  expect(candidate.timings.analyticsExitsMs).toBeUndefined();
  const { from, to, step } = reportWindow(filter, engagementNow);
  const plan = browserReportPlan('workspace', filter, from, to, step, ['app']);
  expect(candidate.queries.slice(1)).toEqual(plan.sql.slice(0, 8));
  expect(isCombinedEngagement(candidate.queries[0])).toBe(true);
});
it('compiles the exact private projection and raw group key without any identity alias', async () => {
  fixture.seed();
  const { from, to, step } = reportWindow(engagementScope, engagementNow);
  const original = browserReportPlan('workspace', engagementScope, from, to, step, ['app']).sql.at(
    -2,
  )!;
  const sql = optionalEngagementSql(original)!;
  expect(sql).toContain('GROUP BY blob1, blob2, blob7 HAVING pageviews > 0');
  expect(sql).not.toMatch(/session_id|SELECT blob1|AS session_hash|AS visitor/);
  expect(sql).toContain(
    "COUNT(DISTINCT IF(blob3 = 'pageview', double2, -1)) - MAX(IF(blob3 = 'pageview', 0, 1))",
  );
  expect(Object.keys(fixture.rows(sql)[0]).sort()).toEqual(
    [
      'name',
      'count',
      'pageviews',
      'bounced_sessions',
      'duration_sum',
      'sample_interval',
      'pageview_sample_interval',
      'ambiguous_sessions',
    ].sort(),
  );
  expect(
    optionalEngagementSql(
      original.replace('GROUP BY blob1, blob2, session_id', 'GROUP BY removed'),
    ),
  ).toBeUndefined();
});
it.each([0, 101, 145])(
  'retains exact original metrics and eleven bounded calls for %i points',
  async (count) => {
    fixture.seed(count);
    const candidate = await pair();
    expect(candidate.queries).toHaveLength(11);
    expect(candidate.timings.analyticsOptionalFallbacks).toBe(1);
    expect(candidate.queries.filter(isCombinedEngagement)).toHaveLength(1);
  },
);
it.each([20, 21])('never truncates global metrics at%i exit paths', async (paths) => {
  fixture.seed(paths, paths, paths);
  const candidate = await pair();
  expect(candidate.queries).toHaveLength(paths === 20 ? 9 : 11);
  expect(candidate.report.engagement?.exit_pages).toHaveLength(20);
});
it.each([27, 30])(
  'rejects incomplete identified PV totals with%i unidentified pageviews',
  async (unidentified) => {
    fixture.seed();
    fixture.database.exec(`UPDATE app_health_browser_v1 SET blob7='' WHERE rowid<=${unidentified}`);
    expect((await pair()).queries).toHaveLength(11);
  },
);
it('rejects ambiguous pageview timestamps while retaining original conditional last-page semantics', async () => {
  fixture.add({ blob7: 's', blob4: '/first' });
  fixture.add({ blob7: 's', blob4: '/tied' });
  fixture.add({
    blob7: 's',
    blob3: 'event',
    blob5: 'opened',
    blob4: '/later',
    double2: engagementNow - 1,
  });
  const result = await pair();
  expect(result.queries).toHaveLength(11);
  expect(result.report.engagement?.exit_pages).toEqual([{ name: '/tied', count: 1 }]);
});
it('preserves exact raw exit tie ordering and blank/Unknown/non-ASCII names', async () => {
  for (const [index, name] of ['', 'Unknown', '/é', '/Ω', '/😀', '/z', '/ß'].entries())
    fixture.add({ blob7: `s${index}`, blob4: name });
  const result = await pair();
  expect(result.queries).toHaveLength(9);
  expect(result.report.engagement?.exit_pages).toEqual([
    { name: 'Unknown', count: 1 },
    { name: '/z', count: 1 },
    { name: '/ß', count: 1 },
    { name: '/é', count: 1 },
    { name: '/Ω', count: 1 },
    { name: '/😀', count: 1 },
    { name: 'Unknown', count: 1 },
  ]);
});
it.each(['pageview', 'event'] as const)(
  'preserves separate sampling behavior for sampled %s rows',
  async (kind) => {
    fixture.seed();
    fixture.add({
      blob3: kind,
      blob5: kind === 'event' ? 'opened' : '',
      blob7: 's0',
      _sample_interval: 2,
    });
    const candidate = await pair();
    expect(candidate.queries).toHaveLength(11);
    expect(candidate.report.sampled).toBe(true);
  },
);
it.each([
  { source: 'google.com' },
  { country: 'IN' },
  { event: 'opened' },
  { range: '7d' as const },
  { range: '30d' as const },
  { app_id: undefined },
  { environment_id: undefined },
  { breakdown: 'acquisition' as const },
])('preserves original SQL/call order and direct admission for %j', async (extra) => {
  fixture.seed();
  const filter = { ...engagementScope, ...extra };
  const original = await runOptionalFixture(fixture, false, filter);
  const candidate = await pair(filter);
  expect(useOptionalEngagement(filter)).toBe(false);
  expect(candidate.queries).toEqual(original.queries);
  expect(candidate.timings.analyticsOptionalAttempts).toBeUndefined();
});
it('keeps direct callers without the internal opt-in on the original ten queries', async () => {
  fixture.seed();
  const result = await runOptionalFixture(fixture, false);
  expect(result.queries).toHaveLength(10);
  expect(result.queries.some(isCombinedEngagement)).toBe(false);
});
it.each(['http', 'json', 'shape', 'partial', 'order', 'cap'] as const)(
  'falls back once on combined %s uncertainty',
  async (mode) => {
    fixture.seed();
    const result = await pair(engagementScope, (sql, rows) => {
      if (!isCombinedEngagement(sql)) return;
      if (mode === 'http') return new Response(null, { status: 503 });
      if (mode === 'json') return new Response('{');
      if (mode === 'cap') return new Response(' '.repeat(1048577));
      return Response.json({
        data:
          mode === 'shape'
            ? rows.map((row) => ({ ...row, session_id: 'forbidden' }))
            : mode === 'partial'
              ? rows.slice(1)
              : [...rows].reverse(),
      });
    });
    expect(result.queries).toHaveLength(11);
    expect(result.timings.analyticsOptionalFallbacks).toBe(1);
  },
);
it.each(['engagement', 'exits'] as const)(
  'settles original %s failure separately and retains the other sample flag',
  async (failed) => {
    fixture.seed();
    const result = await pair(engagementScope, (sql, rows) => {
      if (isCombinedEngagement(sql)) return new Response(null, { status: 503 });
      const engagement = sql.includes('AS pageview_sessions');
      const exits = sql.includes('argMax');
      if ((failed === 'engagement' && engagement) || (failed === 'exits' && exits))
        return new Response(null, { status: 503 });
      if (engagement || exits)
        return Response.json({ data: rows.map((row) => ({ ...row, sample_interval: 2 })) });
    });
    expect(result.report.engagement).toBeUndefined();
    expect(result.report.sampled).toBe(true);
    expect(result.queries).toHaveLength(11);
  },
);
it.each(['headers', 'body'] as const)(
  'recovers at1s from stalled combined %s without late extra dispatch',
  async (mode) => {
    fixture.seed();
    const expected = (await runOptionalFixture(fixture, false)).report;
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    let cancelled = false;
    const queries: string[] = [];
    const pending = queryBrowserReport('workspace', engagementScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      appIds: ['app'],
      optionalEngagement: true,
      fetchImpl: async (_input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        if (isCombinedEngagement(sql))
          return mode === 'headers'
            ? new Promise<Response>((resolve) => {
                release = resolve;
              })
            : new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
              );
        return Response.json({ data: fixture.rows(sql) });
      },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(queries).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(expected);
    expect(queries).toHaveLength(11);
    if (mode === 'headers')
      release(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    await vi.advanceTimersByTimeAsync(10000);
    expect(cancelled).toBe(true);
    expect(queries).toHaveLength(11);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('opts in only account owners and isolates only eligible owner cache keys with the original TTL', async () => {
  fixture.seed();
  const entries = new Map<string, Response>();
  const keys: string[] = [],
    ttls: string[] = [],
    sql: string[] = [];
  vi.stubGlobal('caches', {
    default: {
      match: async (key: Request) => {
        keys.push(decodeURIComponent(key.url));
        return entries.get(key.url)?.clone();
      },
      put: async (key: Request, value: Response) => {
        ttls.push(value.headers.get('cache-control')!);
        entries.set(key.url, value.clone());
      },
    },
  });
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const statement = String(init.body);
    sql.push(statement);
    return Response.json({ data: fixture.rows(statement) });
  });
  const env = {
    BROWSER_ANALYTICS: { writeDataPoint() {} },
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
  };
  const owner = {
    id: 'owner',
    label: 'Owner',
    workspaceId: 'workspace',
    appIds: ['app'],
    authKind: 'account' as const,
  };
  const request = new Request(
    'https://dashboard.example/v1/analytics/report?app_id=app&environment_id=env',
  );
  const timings: OwnerRequestTimings = {};
  const first = await handleBrowserOwner(request, env, owner, false, timings);
  expect(first?.status).toBe(200);
  const firstTimed = withOwnerServerTiming(first!, timings);
  const expected = await firstTimed.json();
  expect(sql).toHaveLength(9);
  expect(keys[0]).toContain('browser-report:optional-only-v7');
  const header = firstTimed.headers.get('server-timing')!;
  expect(header).toContain('analytics_engagement_exits;dur=');
  expect(header).toContain('analytics_optional_attempts;desc="1"');
  expect(header).not.toMatch(/analytics_engagement;|analytics_exits;|synthetic|app_id/);
  const warmTimings: OwnerRequestTimings = {};
  const warm = await handleBrowserOwner(request, env, owner, false, warmTimings);
  const warmTimed = withOwnerServerTiming(warm!, warmTimings);
  expect(await warmTimed.json()).toEqual(expected);
  expect(sql).toHaveLength(9);
  expect(warmTimed.headers.get('server-timing')).not.toContain('analytics_optional_attempts');
  const api = await handleBrowserOwner(
    request,
    env,
    {
      ...owner,
      authKind: 'api-token',
      apiPermission: 'read',
      apiScopes: [{ app_id: 'app', environment_id: 'env' }],
    },
    false,
  );
  expect(await api!.json()).toEqual(expected);
  expect(sql).toHaveLength(19);
  expect(keys.at(-1)).not.toContain('optional-only-v7');
  const filtered = new Request(request.url + '&source=google.com');
  expect((await handleBrowserOwner(filtered, env, owner, false))?.status).toBe(200);
  expect(sql).toHaveLength(27);
  expect(keys.at(-1)).not.toContain('optional-only-v7');
  expect(new Set(ttls)).toEqual(new Set(['max-age=60']));
});

it.each([false, true])(
  'gives each original optional read a fresh ten seconds after the1s watchdog, stalled=%s',
  async (stalled) => {
    fixture.seed();
    const expected = (
      await runOptionalFixture(fixture, false, engagementScope, (sql) =>
        stalled && (sql.includes('AS pageview_sessions') || sql.includes('argMax'))
          ? new Response(null, { status: 503 })
          : undefined,
      )
    ).report;
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    const queries: string[] = [];
    let completed = false;
    const pending = queryBrowserReport('workspace', engagementScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      appIds: ['app'],
      optionalEngagement: true,
      fetchImpl: async (_url, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        if (isCombinedEngagement(sql)) return new Promise<Response>(() => {});
        const data = fixture.rows(sql);
        if (sql.includes('AS pageview_sessions') || sql.includes('argMax'))
          return new Promise<Response>((resolve, reject) => {
            const timer = stalled
              ? undefined
              : setTimeout(() => resolve(Response.json({ data })), 9500);
            init!.signal!.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(init!.signal!.reason);
              },
              { once: true },
            );
          });
        return Response.json({ data });
      },
    }).then((value) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(queries).toHaveLength(11);
    await vi.advanceTimersByTimeAsync(9000);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(stalled ? 1000 : 500);
    expect(await pending).toEqual(expected);
    expect(queries).toHaveLength(11);
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('cancels only new optional work on a mandatory failure and never starts late originals', async () => {
  fixture.seed();
  vi.useFakeTimers();
  const queries: string[] = [];
  let combinedSignal: AbortSignal | undefined;
  const pending = queryBrowserReport('workspace', engagementScope, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    optionalEngagement: true,
    fetchImpl: async (_url, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isCombinedEngagement(sql)) {
        combinedSignal = init!.signal!;
        return new Promise<Response>(() => {});
      }
      if (sql.includes('GROUP BY bucket')) throw new Error('mandatory trend');
      return Response.json({ data: fixture.rows(sql) });
    },
  });
  await expect(pending).rejects.toThrow('mandatory trend');
  expect(combinedSignal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(12000);
  expect(queries).toHaveLength(9);
  expect(vi.getTimerCount()).toBe(0);
});
