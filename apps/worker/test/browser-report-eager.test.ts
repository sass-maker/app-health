import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserReportFilter } from '@app-health/contracts';
import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { queryBrowserReport } from '../src/browser-report-query.js';
import {
  rankingFixture,
  reportNow,
  reportScope,
  observable,
  isPeriods,
  isPages,
} from './ranking-report-fixture.js';
let fixture: ReturnType<typeof rankingFixture>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(reportNow);
  fixture = rankingFixture();
});
afterEach(() => {
  fixture.database.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it('starts only six requests before any provider reply', async () => {
  fixture.seed();
  const provider = fixture.provider();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatches: string[] = [];
  const pending = queryBrowserReport('workspace', reportScope, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: async (input, init) => {
      dispatches.push(String(init?.body));
      await blocked;
      return provider.fetchImpl(input, init);
    },
  });
  try {
    expect(dispatches).toHaveLength(6);
  } finally {
    release();
    await pending;
  }
});

const from = Date.parse('2026-11-12T00:00:00+05:30');
const fixed = { ...reportScope, date: '2026-11-12' };
const isJoint = (sql: string) => sql.includes('GROUP BY event_kind');
type Rows = Record<string, unknown>[];
type Override = (
  sql: string,
  rows: Rows,
  init: RequestInit,
) => Response | Promise<Response> | undefined;
function seed(count: number) {
  for (let i = 0; i < count; i++)
    fixture.add({
      double2: from + 1000 + i,
      blob3: i % 5 === 4 ? 'event' : 'pageview',
      blob5: i % 5 === 4 ? 'opened' : '',
      blob10: i % 3 ? 'www.google.com' : '',
      blob7: 'session' + (i % 3),
    });
  fixture.add({ double2: from + 1000, index1: 'foreign' });
  fixture.add({ double2: from + 1000, blob1: 'foreign' });
  fixture.add({ double2: from + 1000, blob2: 'foreign' });
  fixture.add({ double2: from + 1000, blob3: 'native_session', blob7: 'native', blob8: 'native' });
}
async function execute(filter: BrowserReportFilter, override?: Override) {
  const queries: string[] = [];
  const timings: NonNullable<Parameters<typeof queryBrowserReport>[2]['timings']> = {};
  const result = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    timings,
    fetchImpl: async (_input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      const rows = fixture.database.prepare(sqliteAnalyticsSql(sql)).all();
      return await (override?.(sql, rows, init!) ?? Response.json({ data: rows }));
    },
  });
  return { result, queries, timings };
}
async function pair(filter: BrowserReportFilter = fixed, override?: Override) {
  // A single active-app portfolio with the same environment is equivalent scope; omitting redundant app_id selects the original loader.
  const original = await execute({ ...filter, app_id: undefined }, override);
  const candidate = await execute(filter, override);
  expect(observable(candidate.result)).toEqual(observable(original.result));
  return candidate;
}
it.each([1, 20, 21, 30, 100])(
  'folds exact full report measurements for %i current points',
  async (count) => {
    seed(count);
    for (const breakdown of ['audience', 'technology'] as const) {
      const r = await pair({ ...fixed, breakdown });
      expect(r.queries).toHaveLength(6);
      expect(r.timings.analyticsJointAttempts).toBe(1);
      expect(r.timings.analyticsJointFallbacks).toBeUndefined();
      expect(r.result.series.reduce((sum, row) => sum + row.pageviews + row.events, 0)).toBe(count);
      const joint = r.queries.find(isJoint)!;
      expect(joint).toContain('LIMIT 101');
      expect(joint).toContain("blob3 IN ('pageview', 'event')");
      expect(joint).not.toMatch(/blob[789]\b/);
      expect(new TextEncoder().encode(joint).length).toBeLessThanOrEqual(10000);
    }
  },
);
it.each([0, 101, 120])('falls back exactly once for %i current points', async (count) => {
  seed(count);
  const r = await pair();
  expect(r.queries).toHaveLength(11);
  expect(r.timings.analyticsJointFallbacks).toBe(1);
  expect(r.queries.filter(isJoint)).toHaveLength(1);
});
it.each([
  { event: 'opened' },
  { source: 'google.com' },
  { source: 'Unknown' },
  { path: "/a'b" },
  { entry_path: '/start' },
  { country: 'IN' },
  { device: 'Desktop' },
  { browser: 'Firefox' },
  { channel: 'Email' },
  { campaign: 'hello' },
  { medium: 'email' },
  { content: 'top' },
  { term: 'test' },
] as const)('preserves each scoped filter and four-request path for %j', async (segment) => {
  seed(30);
  for (const breakdown of ['audience', 'technology'] as const) {
    const r = await pair({ ...fixed, breakdown, ...segment });
    expect(r.queries).toHaveLength(4);
    expect(r.result.engagement).toBeUndefined();
    for (const sql of r.queries) {
      expect(sql).toContain("index1 = 'workspace'");
      expect(sql).toContain("blob1 = 'app'");
      expect(sql).toContain("blob2 = 'env'");
      expect(sql).toContain("blob1 IN ('app')");
    }
    const joint = r.queries.find(isJoint)!;
    expect((joint.match(/FROM \(SELECT/g) ?? []).length).toBe(1);
    expect(joint).not.toMatch(/UNION|JOIN|blob[789]\b/);
  }
});
it.each(['7d', '30d'] as const)('leaves original broad %s dispatch unchanged', async (range) => {
  seed(30);
  const r = await execute({ ...fixed, date: undefined, range });
  expect(r.queries).toHaveLength(10);
  expect(r.queries.some(isJoint)).toBe(false);
});
it('keeps acquisition and unscoped portfolios on original immediate queries', async () => {
  seed(30);
  expect((await execute({ ...fixed, breakdown: 'acquisition' })).queries).toHaveLength(12);
  expect((await execute({ ...fixed, app_id: undefined })).queries).toHaveLength(10);
  expect((await execute({ ...fixed, environment_id: undefined })).queries).toHaveLength(10);
});
it('preserves weighted sampled estimates through original fallback', async () => {
  fixture.add({ double2: from + 1000, _sample_interval: 3 });
  const r = await pair();
  expect(r.queries).toHaveLength(11);
  expect(r.result.sampled).toBe(true);
});
it('keeps blank, Unknown, country, event last_seen and distinct native sessions unchanged', async () => {
  fixture.seed();
  fixture.database.exec(
    `UPDATE app_health_browser_v1 SET double2=double2-${reportNow - (from + 86400000 - 1000)}`,
  );
  const r = await pair();
  expect(r.queries).toHaveLength(6);
  expect(r.result.events.some((row) => row.name === 'Unknown')).toBe(true);
});
it.each([
  ['unknown-field', (r: Rows) => r.map((row) => ({ ...row, unexpected: 1 }))],
  ['sampled', (r: Rows) => r.map((row) => ({ ...row, sample_interval: 2 }))],
  ['oversized-label', (r: Rows) => r.map((row) => ({ ...row, source_name: 'x'.repeat(254) }))],
  ['oversized-event', (r: Rows) => r.map((row) => ({ ...row, event_name: 'x'.repeat(65) }))],
  [
    'count-mismatch',
    (r: Rows) =>
      r.map((row, index) => ({ ...row, count: Number(row.count) + (index === 0 ? 1 : 0) })),
  ],
  ['out-of-window', (r: Rows) => r.map((row) => ({ ...row, last_seen: from + 86400000 }))],
  ['duplicate', (r: Rows) => [...r, r[0]]],
  ['overflow', () => Array.from({ length: 101 }, () => ({}))],
  ['wrong-kind', (r: Rows) => r.map((row) => ({ ...row, event_kind: 'native_session' }))],
  ['missing-data', () => null],
] as const)('falls back on %s speculative data', async (_label, mutate) => {
  seed(30);
  const r = await pair(fixed, (sql, rows) =>
    isJoint(sql) ? Response.json({ data: mutate(rows) }) : undefined,
  );
  expect(r.queries).toHaveLength(11);
});
it.each(['sources', 'dimension'] as const)('falls back at a tied top20 %s cutoff', async (kind) => {
  for (let i = 0; i < 21; i++)
    fixture.add({
      double2: from + 1000 + i,
      ...(kind === 'sources' ? { blob10: 'host' + i + '.example' } : { blob17: '/entry' + i }),
    });
  const r = await pair();
  expect(r.queries).toHaveLength(11);
});
it.each(['http', 'network', 'json', 'utf8'] as const)(
  'preserves original success on speculative %s failure',
  async (kind) => {
    seed(30);
    const r = await pair(fixed, (sql) => {
      if (!isJoint(sql)) return;
      if (kind === 'network') throw Error('synthetic transport');
      return kind === 'http'
        ? new Response('unavailable', { status: 503 })
        : kind === 'json'
          ? new Response('{')
          : new Response(new Uint8Array([255]));
    });
    expect(r.queries).toHaveLength(11);
  },
);
it.each([0, 1])('enforces streamed1MiB cap with overflow %i', async (overflow) => {
  seed(30);
  let cancelled = false;
  const r = await pair(fixed, (sql, rows) => {
    if (!isJoint(sql)) return;
    const raw = JSON.stringify({ data: rows });
    const tail = ' '.repeat(1024 * 1024 - raw.length + overflow);
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(raw));
          c.enqueue(new TextEncoder().encode(tail));
          if (!overflow) c.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  expect(r.queries).toHaveLength(overflow ? 11 : 6);
  expect(cancelled).toBe(Boolean(overflow));
});
it('dispatches original five early on high counter without dropping pending optional metrics', async () => {
  seed(101);
  const provider = fixture.provider();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queries: string[] = [];
  let complete = false;
  let jointAborted = false;
  const pending = queryBrowserReport('workspace', fixed, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isJoint(sql)) {
        init!.signal!.addEventListener('abort', () => {
          jointAborted = true;
        });
        return await new Promise<Response>(() => {});
      }
      if (sql.includes('pageview_sessions') || sql.includes('argMax')) await blocked;
      return provider.fetchImpl(input, init);
    },
  }).then((report) => {
    complete = true;
    return report;
  });
  try {
    await vi.waitFor(() => expect(queries).toHaveLength(11));
    expect(jointAborted).toBe(true);
    expect(complete).toBe(false);
  } finally {
    release();
  }
  const report = await pending;
  expect(report.engagement).toBeDefined();
  expect(observable(report)).toEqual(
    observable((await execute({ ...fixed, app_id: undefined })).result),
  );
});
it('dispatches original five on invalid joint before delayed fixed controls', async () => {
  seed(30);
  const provider = fixture.provider();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queries: string[] = [];
  const pending = queryBrowserReport('workspace', fixed, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isJoint(sql)) return Response.json({ data: null });
      if (isPeriods(sql) || isPages(sql) || sql.includes('GROUP BY bucket')) await blocked;
      return provider.fetchImpl(input, init);
    },
  });
  try {
    await vi.waitFor(() => expect(queries).toHaveLength(11));
  } finally {
    release();
  }
  await pending;
  expect(queries.filter(isJoint)).toHaveLength(1);
});
it('dispatches original five on current/trend disagreement while joint headers are stalled', async () => {
  seed(30);
  const provider = fixture.provider();
  const queries: string[] = [];
  const r = await queryBrowserReport('workspace', fixed, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isJoint(sql)) return await new Promise<Response>(() => {});
      if (isPeriods(sql)) {
        const rows = fixture.database.prepare(sqliteAnalyticsSql(sql)).all();
        return Response.json({
          data: rows.map((row) => ({ ...row, pageviews: Number(row.pageviews) + 1 })),
        });
      }
      return provider.fetchImpl(input, init);
    },
  });
  expect(queries).toHaveLength(11);
  expect(r.series.reduce((sum, row) => sum + row.pageviews + row.events, 0)).toBe(30);
});

it.each(['headers', 'body'] as const)(
  'fails closed at shared deadline when original fallback requests stall after joint %s',
  async (mode) => {
    seed(30);
    vi.useFakeTimers();
    vi.setSystemTime(reportNow);
    const provider = fixture.provider();
    const queries: string[] = [];
    const signals: AbortSignal[] = [];
    let cancelled = false;
    const pending = queryBrowserReport('workspace', fixed, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl: async (input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        signals.push(init!.signal!);
        if (isJoint(sql))
          return mode === 'headers'
            ? await new Promise<Response>(() => {})
            : new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
              );
        if (!(
          isPages(sql) ||
          isPeriods(sql) ||
          sql.includes('GROUP BY bucket') ||
          sql.includes('pageview_sessions') ||
          sql.includes('argMax')
        ))
          return await new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
              once: true,
            });
          });
        return provider.fetchImpl(input, init);
      },
    });
    const rejected = expect(pending).rejects.toThrow('Analytics deadline elapsed');
    await vi.advanceTimersByTimeAsync(9999);
    expect(queries).toHaveLength(11);
    expect(
      signals.filter((_, index) => !isJoint(queries[index])).every((signal) => !signal.aborted),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(queries).toHaveLength(11);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancelled).toBe(mode === 'body');
  },
);
it('falls back on an errored speculative stream', async () => {
  seed(30);
  const r = await pair(fixed, (sql) =>
    isJoint(sql)
      ? new Response(
          new ReadableStream({
            start(c) {
              c.error(Error('synthetic stream'));
            },
          }),
        )
      : undefined,
  );
  expect(r.queries).toHaveLength(11);
});
it('dispatches originals early for a sampled page control even when joint headers never arrive', async () => {
  seed(30);
  const provider = fixture.provider();
  const queries: string[] = [];
  const report = await queryBrowserReport('workspace', fixed, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isJoint(sql)) return await new Promise<Response>(() => {});
      if (isPages(sql))
        return Response.json({
          data: fixture.database
            .prepare(sqliteAnalyticsSql(sql))
            .all()
            .map((row) => ({ ...row, sample_interval: 2 })),
        });
      return provider.fetchImpl(input, init);
    },
  });
  expect(queries).toHaveLength(11);
  expect(report.sampled).toBe(true);
});

it.each(['overflow', 'cutoff-tie'] as const)(
  'dispatches original five before fixed controls after decisive joint %s',
  async (reason) => {
    if (reason === 'overflow') seed(101);
    else
      for (let i = 0; i < 21; i++)
        fixture.add({ double2: from + 1000 + i, blob10: 'host' + i + '.example' });
    const provider = fixture.provider();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queries: string[] = [];
    const pending = queryBrowserReport('workspace', fixed, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl: async (input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        if (isPeriods(sql) || isPages(sql) || sql.includes('GROUP BY bucket')) await blocked;
        return provider.fetchImpl(input, init);
      },
    });
    try {
      await vi.waitFor(() => expect(queries).toHaveLength(11));
    } finally {
      release();
    }
    const result = await pending;
    expect(result.pages).toHaveLength(1);
    if (reason === 'cutoff-tie') expect(result.sources).toHaveLength(20);
  },
);

it.each(
  ['trend', 'period', 'pages'].flatMap((control) =>
    ['joint-first', 'control-first'].map((order) => ({ control, order })),
  ),
)(
  'dispatches originals on cross-result mismatch for $control/$order before unrelated controls',
  async ({ control, order }) => {
    seed(30);
    const queries: string[] = [];
    let releaseOther!: () => void;
    let releaseArrival!: () => void;
    const other = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const arrival = new Promise<void>((resolve) => {
      releaseArrival = resolve;
    });
    let firstReady = false;
    const pending = queryBrowserReport('workspace', fixed, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl: async (_input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        const kind = isPeriods(sql)
          ? 'period'
          : isPages(sql)
            ? 'pages'
            : sql.includes('GROUP BY bucket')
              ? 'trend'
              : undefined;
        if (isJoint(sql)) {
          if (order === 'control-first') await arrival;
          else firstReady = true;
        } else if (kind) {
          if (kind !== control) await other;
          else if (order === 'joint-first') await arrival;
          else firstReady = true;
        }
        let rows = fixture.database.prepare(sqliteAnalyticsSql(sql)).all();
        if (isJoint(sql))
          rows = rows.map((row) => ({
            ...row,
            source_name: 'speculative-only',
            dim0: 'speculative-only',
            event_name: row.event_kind === 'event' ? 'speculative.only' : row.event_name,
          }));
        if (kind === control)
          rows = rows.map((row) => ({
            ...row,
            ...(control === 'period' ? { visitors: Number(row.visitors) + 1 } : {}),
            [control === 'pages' ? 'count' : 'pageviews']:
              Number(row[control === 'pages' ? 'count' : 'pageviews']) + 1,
          }));
        return Response.json({ data: rows });
      },
    });
    try {
      await vi.waitFor(() => expect(firstReady).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseArrival();
      await vi.waitFor(() => expect(queries).toHaveLength(11), { timeout: 200, interval: 5 });
    } finally {
      releaseArrival();
      releaseOther();
      await pending;
    }
    expect(queries.filter(isJoint)).toHaveLength(1);
    const result = await pending;
    const expected = (await execute({ ...fixed, app_id: undefined })).result;
    if (control === 'trend') expected.series[0].pageviews += 1;
    else if (control === 'pages') expected.pages[0].count += 1;
    else expected.audience!.visitors += 1;
    expect(observable(result)).toEqual(observable(expected));
  },
);

it.each([0, 10])(
  'accepts the original valid top20 page selection starting at%i among30 tied pages',
  async (offset) => {
    for (let i = 0; i < 30; i++)
      fixture.add({ double2: from + 1000 + i, blob4: '/distinct-' + String(i).padStart(2, '0') });
    const selected = Array.from({ length: 20 }, (_, i) => ({
      name: '/distinct-' + String(offset + i).padStart(2, '0'),
      count: 1,
      sample_interval: 1,
    }));
    const original = await execute({ ...fixed, app_id: undefined }, (sql) =>
      isPages(sql) ? Response.json({ data: selected }) : undefined,
    );
    const candidate = await execute(fixed, (sql) =>
      isPages(sql) ? Response.json({ data: selected }) : undefined,
    );
    expect(candidate.result).toEqual(original.result);
    expect(candidate.result.pages).toEqual(selected.map(({ name, count }) => ({ name, count })));
    expect(candidate.queries).toHaveLength(6);
    expect(candidate.timings.analyticsJointFallbacks).toBeUndefined();
  },
);

function distinctPages(count = 30) {
  for (let i = 0; i < count; i++)
    fixture.add({ double2: from + 1000 + i, blob4: '/distinct-' + String(i).padStart(2, '0') });
}
function selectedPages(offset = 0) {
  return Array.from({ length: 20 }, (_, i) => ({
    name: '/distinct-' + String(offset + i).padStart(2, '0'),
    count: 1,
    sample_interval: 1,
  }));
}
async function pagePair(control: Rows, filter: BrowserReportFilter = fixed) {
  const override: Override = (sql) => (isPages(sql) ? Response.json({ data: control }) : undefined);
  const original = await execute({ ...filter, app_id: undefined }, override);
  const candidate = await execute(filter, override);
  expect(candidate.result).toEqual(original.result);
  expect(candidate.result.pages).toEqual(
    control.map((row) => ({ name: row.name || 'Unknown', count: Number(row.count) })),
  );
  return candidate;
}
it.each([30, 100, 101, 145])(
  'keeps bounded full page margins for%i distinct pages',
  async (count) => {
    distinctPages(count);
    const r = await pagePair(selectedPages(10).reverse());
    expect(r.queries).toHaveLength(count <= 100 ? 6 : 11);
    expect(r.timings.analyticsJointFallbacks).toBe(count <= 100 ? undefined : 1);
  },
);
it.each([
  ['missing', (rows: Rows) => rows.slice(1)],
  ['empty', (_rows: Rows) => []],
  ['too-many', (rows: Rows) => [...rows, { name: '/distinct-29', count: 1, sample_interval: 1 }]],
  ['duplicate', (rows: Rows) => [rows[0], ...rows.slice(0, 19)]],
  ['unknown-name', (rows: Rows) => [{ ...rows[0], name: '/not-in-joint' }, ...rows.slice(1)]],
  ['wrong-count', (rows: Rows) => [{ ...rows[0], count: 2 }, ...rows.slice(1)]],
  ['zero-count', (rows: Rows) => [...rows.slice(0, 19), { ...rows[19], count: 0 }]],
  ['sampled', (rows: Rows) => rows.map((row) => ({ ...row, sample_interval: 2 }))],
  ['oversized-name', (rows: Rows) => [{ ...rows[0], name: 'x'.repeat(257) }, ...rows.slice(1)]],
] as const)('retains original report and falls back for %s page control', async (_name, mutate) => {
  distinctPages();
  const r = await pagePair(mutate(selectedPages()));
  expect(r.queries).toHaveLength(11);
  expect(r.timings.analyticsJointFallbacks).toBe(1);
});
it('rejects a control omitting a strictly larger page despite all selected names/counts matching', async () => {
  distinctPages();
  for (let i = 0; i < 3; i++) fixture.add({ double2: from + 2000 + i, blob4: '/larger' });
  expect((await pagePair(selectedPages())).queries).toHaveLength(11);
});
it('rejects forged top counts on lower pages and a non-descending page selection', async () => {
  distinctPages();
  fixture.add({ double2: from + 2000, blob4: '/larger' });
  expect(
    (
      await pagePair([
        { name: '/distinct-00', count: 2, sample_interval: 1 },
        ...selectedPages(1).slice(0, 19),
      ])
    ).queries,
  ).toHaveLength(11);
  expect(
    (
      await pagePair([
        ...selectedPages().slice(0, 19),
        { name: '/larger', count: 2, sample_interval: 1 },
      ])
    ).queries,
  ).toHaveLength(11);
});
it('preserves distinct raw blank and Unknown page keys before report normalization', async () => {
  distinctPages();
  fixture.database.exec(
    "UPDATE app_health_browser_v1 SET blob4='' WHERE blob4='/distinct-00'; UPDATE app_health_browser_v1 SET blob4='Unknown' WHERE blob4='/distinct-01'",
  );
  const control = [
    { name: '', count: 1, sample_interval: 1 },
    { name: 'Unknown', count: 1, sample_interval: 1 },
    ...selectedPages(2).slice(0, 18),
  ];
  const r = await pagePair(control);
  expect(r.queries).toHaveLength(6);
  expect(r.result.pages.slice(0, 2)).toEqual([
    { name: 'Unknown', count: 1 },
    { name: 'Unknown', count: 1 },
  ]);
});
it.each(['audience', 'technology'] as const)(
  'accepts tied page controls with %s source segmentation',
  async (breakdown) => {
    distinctPages();
    const r = await pagePair(selectedPages(10), { ...fixed, breakdown, source: 'google.com' });
    expect(r.queries).toHaveLength(4);
    expect(r.timings.analyticsJointFallbacks).toBeUndefined();
  },
);
it.each(['blob13', 'blob17', 'blob16', 'blob14', 'blob15'] as const)(
  'retains the non-page %s cutoff guard',
  async (blob) => {
    for (let i = 0; i < 21; i++) fixture.add({ double2: from + 1000 + i, [blob]: 'value' + i });
    const breakdown = blob === 'blob14' || blob === 'blob15' ? 'technology' : 'audience';
    const r = await pair({ ...fixed, breakdown });
    expect(r.queries).toHaveLength(11);
    expect(r.timings.analyticsJointFallbacks).toBe(1);
  },
);
it.each(['name', 'count'] as const)(
  'preserves original errors for malformed page %s without retry',
  async (field) => {
    distinctPages();
    const controls = selectedPages().map((row, index) =>
      index ? row : { ...row, [field]: field === 'name' ? null : 'invalid' },
    );
    for (const filter of [{ ...fixed, app_id: undefined }, fixed]) {
      const queries: string[] = [];
      await expect(
        execute(filter, (sql) => {
          queries.push(sql);
          return isPages(sql) ? Response.json({ data: controls }) : undefined;
        }),
      ).rejects.toThrow();
      expect(queries).toHaveLength(filter.app_id ? 11 : 10);
      expect(queries.filter(isJoint)).toHaveLength(filter.app_id ? 1 : 0);
    }
  },
);

it.each(['headers', 'body'] as const)(
  'returns the exact original report after a pending optional joint %s reaches2000ms',
  async (mode) => {
    seed(30);
    const expected = (await execute({ ...fixed, app_id: undefined })).result;
    vi.useFakeTimers();
    vi.setSystemTime(reportNow);
    const provider = fixture.provider();
    const queries: string[] = [];
    let cancelled = false;
    let releaseHeaders: ((response: Response) => void) | undefined;
    const pending = queryBrowserReport('workspace', fixed, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      appIds: ['app'],
      fetchImpl: async (input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        if (isJoint(sql))
          return mode === 'headers'
            ? await new Promise<Response>((resolve) => {
                releaseHeaders = resolve;
              })
            : new Response(
                new ReadableStream({
                  cancel() {
                    cancelled = true;
                  },
                }),
              );
        return provider.fetchImpl(input, init);
      },
    }).then(
      (report) => ({ report, error: undefined }),
      (error: unknown) => ({ report: undefined, error }),
    );
    try {
      await vi.advanceTimersByTimeAsync(1999);
      expect(queries).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(queries).toHaveLength(11);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.report).toEqual(expected);
      if (releaseHeaders) {
        releaseHeaders(
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(cancelled).toBe(true);
      await vi.advanceTimersByTimeAsync(10000);
      expect(queries).toHaveLength(11);
      expect(new Set(queries).size).toBe(11);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(10000);
      await pending;
    }
  },
);

it('rejects a delayed watchdog past the shared deadline without dispatching or leaking a timer', async () => {
  seed(30);
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const provider = fixture.provider();
  const queries: string[] = [];
  const pending = queryBrowserReport('workspace', fixed, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      if (isJoint(sql)) return await new Promise<Response>(() => {});
      return provider.fetchImpl(input, init);
    },
  });
  const rejected = expect(pending).rejects.toThrow('Analytics deadline elapsed');
  await vi.advanceTimersByTimeAsync(0);
  expect(queries).toHaveLength(6);
  clock = 10001;
  await vi.advanceTimersByTimeAsync(2000);
  await rejected;
  await vi.advanceTimersByTimeAsync(10000);
  expect(queries).toHaveLength(6);
  expect(vi.getTimerCount()).toBe(0);
});
