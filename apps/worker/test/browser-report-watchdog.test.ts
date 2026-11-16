import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserReportFilter } from '@app-health/contracts';
import { queryBrowserReport } from '../src/browser-report-query.js';
import { browserReportPlan } from '../src/browser-report-plan.js';
import { foldJointRankings } from '../src/browser-report-joint.js';
import {
  rankingFixture,
  reportNow,
  reportScope,
  observable,
  isJoint,
  isPages,
  isPeriods,
} from './ranking-report-fixture.js';

const options = { accountId: 'a'.repeat(32), token: 'synthetic', appIds: ['app'] };
let fixture: ReturnType<typeof rankingFixture>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(reportNow);
  fixture = rankingFixture();
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
});
async function run(
  filter: BrowserReportFilter = reportScope,
  config: Parameters<typeof fixture.provider>[0] = {},
) {
  const provider = fixture.provider(config);
  const timings = {};
  const report = await queryBrowserReport('workspace', filter, {
    ...options,
    fetchImpl: provider.fetchImpl,
    timings,
  });
  return { report, ...provider, timings };
}

describe('original-pages watchdog report parity', () => {
  it.each(['audience', 'technology'] as const)(
    'preserves the full %s report with six provider calls',
    async (breakdown) => {
      fixture.seed();
      const filter = { ...reportScope, breakdown };
      const original = await run(filter, { first: 'pages' });
      const fast = await run(filter);
      expect(observable(fast.report)).toEqual(observable(original.report));
      expect(original.queries).toHaveLength(10);
      expect(fast.queries).toHaveLength(6);
      expect(fast.report.pages).toEqual(original.report.pages);
      expect(fast.report.events).toContainEqual({
        name: 'opened',
        count: 2,
        last_seen: reportNow - 800,
      });
      expect(fast.report.events).toContainEqual({
        name: 'Unknown',
        count: 1,
        last_seen: reportNow - 700,
      });
      expect(fast.report.audience?.countries).toContainEqual({ name: 'Unknown', count: 3 });
      expect(fast.report.previous?.pageviews).toBe(1);
      expect(fast.report.engagement).toBeDefined();
      expect(fast.timings).toMatchObject({ analyticsJointAttempts: 1 });
      expect(fast.timings).not.toHaveProperty('analyticsSourcesMs');
      for (const sql of fast.queries) {
        expect(sql).toContain("index1 = 'workspace'");
        expect(sql).toContain("blob1 = 'app'");
        expect(sql).toContain("blob2 = 'env'");
        expect(sql).toContain("blob1 IN ('app')");
      }
      const sql = fast.queries.find(isJoint)!;
      expect(sql).not.toMatch(/blob[78]\b|SELECT \*,/);
      expect(new TextEncoder().encode(sql).length).toBeLessThanOrEqual(10_000);
      expect((sql.match(/FROM \(SELECT/g) ?? []).length).toBe(1);
    },
  );

  const segments: Partial<BrowserReportFilter>[] = [
    { event: 'opened' },
    { source: 'google.com' },
    { path: "/a'b" },
    { entry_path: '/start' },
    { country: 'Unknown' },
    { device: 'Desktop' },
    { browser: 'Firefox' },
    { channel: 'Email' },
    { campaign: 'hello' },
    { medium: 'email' },
    { content: 'top' },
    { term: 'test' },
  ];
  it.each(segments)('preserves actual SQL filter and event semantics for %j', async (segment) => {
    fixture.seed();
    for (const breakdown of ['audience', 'technology'] as const) {
      const filter = { ...reportScope, breakdown, ...segment };
      const original = await run(filter, { first: 'pages' });
      const fast = await run(filter);
      expect(observable(fast.report)).toEqual(observable(original.report));
      expect(fast.queries).toHaveLength(4);
      expect(original.queries).toHaveLength(8);
      expect(fast.report.engagement).toBeUndefined();
    }
  });

  it.each(['1h', '24h'] as const)(
    'uses the same loader for rolling %s and completed India dates',
    async (range) => {
      fixture.seed();
      const rolling = await run({ ...reportScope, range });
      expect(rolling.queries).toHaveLength(6);
      const date = '2026-11-12';
      const from = Date.parse(`${date}T00:00:00+05:30`);
      fixture.add({ double2: from });
      fixture.add({ double2: from + 86_400_000 });
      const historical = await run({ ...reportScope, range: '24h', date });
      expect(historical.report.from).toBe(from);
      expect(historical.report.to).toBe(from + 86_400_000);
      expect(historical.report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(1);
      expect(historical.queries).toHaveLength(6);
    },
  );

  it.each([
    {},
    { range: '7d' as const },
    { range: '30d' as const },
    { breakdown: 'acquisition' as const },
  ])('leaves known broad cases on original immediate SQL %j', async (extra) => {
    fixture.seed();
    const filter = Object.keys(extra).length
      ? { ...reportScope, ...extra }
      : { range: '24h' as const };
    const result = await run(filter);
    expect(result.queries.some(isJoint)).toBe(false);
    expect(result.queries).toHaveLength(extra.breakdown ? 12 : 10);
    expect(result.queries[2]).toContain('AS name');
  });

  it.each([0, 20, 21])(
    'bounds the current total at %i and excludes previous activity',
    async (current) => {
      for (let i = 0; i < current; i++) fixture.add();
      for (let i = 0; i < 50; i++) fixture.add({ double2: reportNow - 90_000_000 });
      const result = await run();
      expect(result.queries).toHaveLength(current === 20 ? 6 : 10);
      expect(result.report.previous?.pageviews).toBe(50);
    },
  );

  it.each(['pages', 'same'] as const)(
    'keeps the irreversible original choice when %s finishes first',
    async (first) => {
      fixture.seed();
      const result = await run(reportScope, { first });
      expect(result.queries).toHaveLength(10);
      expect(result.queries.some(isJoint)).toBe(false);
    },
  );

  it.each([1.25, 3])(
    'preserves weighted sampled original estimates for raw interval %s',
    async (sample) => {
      fixture.seed();
      fixture.database.prepare('UPDATE app_health_browser_v1 SET _sample_interval=?').run(sample);
      const original = await run(reportScope, { first: 'pages' });
      const result = await run();
      expect(observable(result.report)).toEqual(observable(original.report));
      expect(result.report.sampled).toBe(true);
      expect(result.queries).toHaveLength(10);
    },
  );
});

const invalidJoint = [
  ['101 groups', (rows: Record<string, unknown>[]) => Array.from({ length: 101 }, () => rows[0])],
  [
    'fractional sampling',
    (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, sample_interval: 1.25 })),
  ],
  [
    'missing sample',
    (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, sample_interval: null })),
  ],
  [
    'unexpected field',
    (rows: Record<string, unknown>[]) =>
      rows.map((r) => ({ ...r, visitor_hash: 'must-never-appear' })),
  ],
  ['duplicate group', (rows: Record<string, unknown>[]) => [...rows, rows[0]]],
  [
    'timestamp outside window',
    (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, last_seen: reportNow })),
  ],
  [
    'fractional count',
    (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, count: 1.5 })),
  ],
  [
    'unknown event kind',
    (rows: Record<string, unknown>[]) => rows.map((r) => ({ ...r, event_kind: 'other' })),
  ],
] as const;
it.each(invalidJoint)(
  'falls back once on successful but invalid joint %s',
  async (_name, change) => {
    fixture.seed();
    const original = await run(reportScope, { first: 'pages' });
    const result = await run(reportScope, {
      transform: (sql, rows) => (isJoint(sql) ? change(rows) : rows),
    });
    expect(observable(result.report)).toEqual(observable(original.report));
    expect(result.queries).toHaveLength(11);
    expect(result.queries.filter(isPages)).toHaveLength(1);
    expect(result.timings).toMatchObject({ analyticsJointAttempts: 1, analyticsJointFallbacks: 1 });
  },
);

it.each(['joint', 'trend', 'pages'])(
  'detects late arrivals against the independent %s control',
  async (changed) => {
    fixture.seed();
    const result = await run(reportScope, {
      transform: (sql, rows) => {
        if (changed === 'joint' && isJoint(sql))
          return rows.map((row, index) => (index ? row : { ...row, count: Number(row.count) + 1 }));
        if (changed === 'trend' && sql.includes('GROUP BY bucket'))
          return rows.map((row, index) =>
            index ? row : { ...row, pageviews: Number(row.pageviews) + 1 },
          );
        if (changed === 'pages' && isPages(sql)) return rows.slice(1);
        return rows;
      },
    });
    expect(result.queries).toHaveLength(11);
    expect(result.timings).toHaveProperty('analyticsJointFallbacks', 1);
  },
);

it('isolates optional failures and fails mandatory responses without a blind joint retry', async () => {
  fixture.seed();
  const optional = await run(reportScope, {
    before: (sql) => {
      if (sql.includes('pageview_sessions')) throw Error('optional');
    },
  });
  expect(optional.report.engagement).toBeUndefined();
  expect(optional.queries).toHaveLength(6);
  for (const failing of [
    isJoint,
    isPages,
    isPeriods,
    (sql: string) => sql.includes('GROUP BY bucket'),
  ]) {
    const provider = fixture.provider({
      before: (sql) => {
        if (failing(sql)) throw Error('transport');
      },
    });
    await expect(
      queryBrowserReport('workspace', reportScope, { ...options, fetchImpl: provider.fetchImpl }),
    ).rejects.toThrow('transport');
    expect(provider.queries.length).toBeLessThanOrEqual(6);
  }
});

it('accepts 100 complete groups only with matching controls and rejects cutoff ties', () => {
  const from = reportNow - 86_400_000;
  const plan = browserReportPlan('workspace', reportScope, from, reportNow, 3_600_000, ['app']);
  const rows = Array.from({ length: 100 }, (_, i) => ({
    event_kind: 'pageview',
    page_path: '/',
    event_name: '',
    source_name: 'Google',
    dim0: 'Email',
    dim1: '/start',
    dim2: 'IN',
    count: 1,
    last_seen: reportNow - 1 - i,
    sample_interval: 1,
  }));
  rows.forEach((row, i) => {
    row.event_name = String(i);
  });
  const args = {
    data: rows,
    filter: reportScope,
    from,
    to: reportNow,
    dimensions: plan.dimensionBlobs,
    counter: { pageviews: 100, events: 0 },
    trend: [{ bucket: 0, pageviews: 100, events: 0, sample_interval: 1 }],
    pages: [{ name: '/', count: 100, sample_interval: 1 }],
  };
  expect(foldJointRankings(args)?.sources).toEqual([
    { name: 'Google', count: 100, last_seen: reportNow - 1, sample_interval: 1 },
  ]);
  expect(
    foldJointRankings({ ...args, data: [...rows, { ...rows[0], event_name: 'overflow' }] }),
  ).toBeUndefined();
  const tied = rows.slice(0, 21).map((row, i) => ({ ...row, source_name: `source${i}` }));
  expect(
    foldJointRankings({
      ...args,
      data: tied,
      counter: { pageviews: 21, events: 0 },
      trend: [{ bucket: 0, pageviews: 21, events: 0, sample_interval: 1 }],
      pages: [{ name: '/', count: 21, sample_interval: 1 }],
    }),
  ).toBeUndefined();
});

it.each([
  { pageviews: null },
  { pageviews: '' },
  { events: true },
  { sample_interval: null },
  { sample_interval: 1.25 },
])('keeps original report parsing when the current counter cannot qualify: %j', async (change) => {
  fixture.seed();
  const transform = (sql: string, rows: Record<string, unknown>[]) =>
    isPeriods(sql)
      ? rows.map((row) => (Number(row.period) === 1 ? { ...row, ...change } : row))
      : rows;
  const original = await run(reportScope, { first: 'pages', transform });
  const result = await run(reportScope, { transform });
  expect(observable(result.report)).toEqual(observable(original.report));
  expect(result.queries).toHaveLength(10);
  expect(result.queries.some(isJoint)).toBe(false);
});

it('retains previous-period sampling while allowing an exact current counter', async () => {
  fixture.seed();
  fixture.database
    .prepare('UPDATE app_health_browser_v1 SET _sample_interval=3 WHERE double2<?')
    .run(reportNow - 86_400_000);
  const original = await run(reportScope, { first: 'pages' });
  const result = await run();
  expect(observable(result.report)).toEqual(observable(original.report));
  expect(result.queries).toHaveLength(6);
  expect(result.report.sampled).toBe(true);
  expect(result.report.engagement?.bounce_rate).toBeNull();
});

it('keeps an absent current period on the original loader even with a sampled previous row', async () => {
  fixture.add({ double2: reportNow - 90_000_000, _sample_interval: 3 });
  const result = await run();
  expect(result.queries).toHaveLength(10);
  expect(result.report.sampled).toBe(true);
  expect(result.report.sessions).toBe(0);
});

it('bounds event-mode decoded fallback to nine calls and one original pages result', async () => {
  fixture.seed();
  const filter = { ...reportScope, event: 'opened' };
  const original = await run(filter, { first: 'pages' });
  const result = await run(filter, { transform: (sql, rows) => (isJoint(sql) ? null : rows) });
  expect(observable(result.report)).toEqual(observable(original.report));
  expect(result.queries).toHaveLength(9);
  expect(result.queries.filter(isPages)).toHaveLength(1);
});

it('falls back after a real 20-to-101 row late arrival without presenting truncated groups as complete', async () => {
  for (let i = 0; i < 20; i++) fixture.add({ blob4: `/original${i}` });
  let added = false;
  const result = await run(reportScope, {
    before: (sql) => {
      if (isJoint(sql) && !added) {
        added = true;
        for (let i = 0; i < 81; i++) fixture.add({ blob4: `/late${i}` });
      }
    },
  });
  expect(result.queries).toHaveLength(11);
  expect(result.report.pages).toHaveLength(20);
  expect(result.report.pages.every((row) => row.name.startsWith('/original'))).toBe(true);
  expect(result.report.sources).toEqual([{ name: 'Google', count: 101 }]);
  expect(result.report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(20);
});

it('cancels all started requests on mandatory failure without unhandled page rejections', async () => {
  fixture.seed();
  const signals: AbortSignal[] = [];
  const provider = fixture.provider();
  const fetchImpl: typeof fetch = async (input, init) => {
    signals.push(init!.signal!);
    if (String(init?.body).includes('GROUP BY bucket')) throw Error('mandatory trend');
    return provider.fetchImpl(input, init);
  };
  await expect(
    queryBrowserReport('workspace', reportScope, { ...options, fetchImpl }),
  ).rejects.toThrow('mandatory trend');
  expect(signals.length).toBeGreaterThanOrEqual(5);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it('enforces the absolute deadline even before its abort timer can be dispatched', async () => {
  fixture.seed();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const provider = fixture.provider({
    transform: (sql, rows) => {
      if (isJoint(sql)) clock = 10_001;
      return rows;
    },
  });
  await expect(
    queryBrowserReport('workspace', reportScope, { ...options, fetchImpl: provider.fetchImpl }),
  ).rejects.toThrow('Analytics deadline elapsed');
  expect(provider.queries).toHaveLength(6);
  expect(provider.queries.filter(isPages)).toHaveLength(1);
});

it.each(['pages', 'counter'] as const)(
  'starts all five useful independent calls before the %s watchdog decision',
  async (first) => {
    fixture.seed();
    const provider = fixture.provider({ first: 'same' });
    let releasePages!: () => void;
    let releasePeriods!: () => void;
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await provider.fetchImpl(input, init);
      if (isPages(String(init?.body)))
        return new Promise((resolve) => {
          releasePages = () => resolve(response);
        });
      if (isPeriods(String(init?.body)))
        return new Promise((resolve) => {
          releasePeriods = () => resolve(response);
        });
      return response;
    };
    const pending = queryBrowserReport('workspace', reportScope, { ...options, fetchImpl });
    await vi.waitFor(() => {
      expect(releasePages).toBeTypeOf('function');
      expect(releasePeriods).toBeTypeOf('function');
    });
    expect(provider.queries).toHaveLength(5);
    expect(provider.queries.some((sql) => sql.includes('pageview_sessions'))).toBe(true);
    expect(provider.queries.some((sql) => sql.includes('argMax'))).toBe(true);
    if (first === 'pages') releasePages();
    else releasePeriods();
    await vi.waitFor(() => expect(provider.queries).toHaveLength(first === 'pages' ? 10 : 6));
    if (first === 'pages') releasePeriods();
    else releasePages();
    const result = await pending;
    expect(result.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(5);
    expect(provider.queries.filter(isPages)).toHaveLength(1);
  },
);

it('fails a late original-pages rejection after the joint decision without unhandled retries', async () => {
  fixture.seed();
  const provider = fixture.provider({ first: 'same' });
  let rejectPages!: (error: Error) => void;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (isPages(String(init?.body))) {
      await provider.fetchImpl(input, init);
      return new Promise((_resolve, reject) => {
        rejectPages = reject;
      });
    }
    return provider.fetchImpl(input, init);
  };
  const pending = queryBrowserReport('workspace', reportScope, { ...options, fetchImpl });
  const rejected = expect(pending).rejects.toThrow('late pages failure');
  await vi.waitFor(() => expect(provider.queries.some(isJoint)).toBe(true));
  rejectPages(Error('late pages failure'));
  await rejected;
  expect(provider.queries).toHaveLength(6);
});
