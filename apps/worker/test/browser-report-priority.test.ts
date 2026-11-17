import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserReportFilter } from '@app-health/contracts';
import { queryBrowserReport } from '../src/browser-report-query.js';
import { browserReportPlan } from '../src/browser-report-plan.js';
import { reportWindow } from '../src/browser-report-window.js';
import { rankingFixture, reportNow, reportScope, isPages } from './ranking-report-fixture.js';

let fixture: ReturnType<typeof rankingFixture>;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(reportNow);
  fixture = rankingFixture();
});
afterEach(() => {
  fixture.database.close();
  vi.restoreAllMocks();
});
async function run(filter: BrowserReportFilter = reportScope) {
  const provider = fixture.provider();
  const report = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: provider.fetchImpl,
  });
  return { report, ...provider };
}

it.each(['audience', 'technology', 'acquisition'] as const)(
  'preserves full %s measurements with scoped dispatch',
  async (breakdown) => {
    fixture.seed();
    const result = await run({ ...reportScope, breakdown });
    expect(result.queries).toHaveLength(breakdown === 'acquisition' ? 12 : 7);
    if (breakdown !== 'acquisition') {
      expect(result.queries[2]).toContain('source_value');
      expect(result.queries[5]).toContain('pageview_sessions');
      expect(result.queries[6]).toContain('argMax');
    }
    expect(result.queries.filter(isPages)).toHaveLength(1);
    const { from, to, step } = reportWindow({ ...reportScope, breakdown }, reportNow);
    const { sql, jointSql } = browserReportPlan(
      'workspace',
      { ...reportScope, breakdown },
      from,
      to,
      step,
      ['app'],
    );
    expect(result.queries).toEqual(
      jointSql ? [sql[0], sql[1], sql[2], sql[4], jointSql, ...sql.slice(-2)] : sql,
    );
    expect(result.report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(5);
    expect(result.report.series.reduce((sum, row) => sum + row.events, 0)).toBe(3);
    expect(result.report.previous?.pageviews).toBe(1);
    expect(result.report.sources).toContainEqual({ name: 'Unknown', count: 1 });
    expect(result.report.events).toContainEqual({
      name: 'opened',
      count: 2,
      last_seen: reportNow - 800,
    });
    expect(result.report.engagement).toBeDefined();
  },
);

it.each([
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
] as const)('retains SQL filtering and five immediate required queries for %j', async (segment) => {
  fixture.seed();
  for (const breakdown of ['audience', 'technology'] as const) {
    const result = await run({ ...reportScope, breakdown, ...segment });
    expect(result.queries).toHaveLength(5);
    expect(result.queries.filter(isPages)).toHaveLength(1);
    expect(
      result.queries.some((sql) => sql.includes('pageview_sessions') || sql.includes('argMax')),
    ).toBe(false);
    expect(result.report.engagement).toBeUndefined();
    for (const sql of result.queries) {
      expect(sql).toContain("index1 = 'workspace'");
      expect(sql).toContain("blob1 = 'app'");
      expect(sql).toContain("blob2 = 'env'");
      expect(sql).toContain("blob1 IN ('app')");
    }
  }
});

it.each([0, 1, 20, 21, 101])(
  'preserves original page truncation for %i current events',
  async (count) => {
    for (let index = 0; index < count; index++) fixture.add({ blob4: `/path${index}` });
    const result = await run();
    expect(result.queries).toHaveLength(count >= 1 && count <= 100 ? 7 : 11);
    expect(result.report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(count);
    expect(result.report.pages.length).toBe(Math.min(count, 20));
  },
);

it.each(['1h', '24h', '7d', '30d'] as const)(
  'preserves original immediate behavior for %s',
  async (range) => {
    fixture.seed();
    const selected = { ...reportScope, range };
    const result = await run(selected);
    expect(result.queries).toHaveLength(range === '7d' || range === '30d' ? 10 : 7);
    if (range === '7d' || range === '30d') {
      const { from, to, step } = reportWindow(selected, reportNow);
      expect(result.queries).toEqual(
        browserReportPlan('workspace', selected, from, to, step, ['app']).sql,
      );
    }
  },
);

it('keeps exact completed India-day edges and weighted sampled estimates', async () => {
  const from = Date.parse('2026-11-12T00:00:00+05:30');
  fixture.add({ double2: from, _sample_interval: 3 });
  fixture.add({ double2: from + 86400000, _sample_interval: 3 });
  const result = await run({ ...reportScope, date: '2026-11-12' });
  expect(result.report.from).toBe(from);
  expect(result.report.to).toBe(from + 86400000);
  expect(result.report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(3);
  expect(result.report.sampled).toBe(true);
  expect(result.queries).toHaveLength(11);
});

it('aborts all started work on a mandatory failure without retrying', async () => {
  fixture.seed();
  const signals: AbortSignal[] = [];
  const provider = fixture.provider();
  const fetchImpl: typeof fetch = async (input, init) => {
    signals.push(init!.signal!);
    if (String(init?.body).includes('GROUP BY bucket')) throw Error('mandatory trend');
    return provider.fetchImpl(input, init);
  };
  await expect(
    queryBrowserReport('workspace', reportScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl,
    }),
  ).rejects.toThrow('mandatory trend');
  expect(signals).toHaveLength(7);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it('enforces the absolute provider deadline before delayed timer dispatch', async () => {
  fixture.seed();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const provider = fixture.provider();
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await provider.fetchImpl(input, init);
    const json = response.json.bind(response);
    response.json = async <T>() => {
      const body = await json();
      clock = 10001;
      return body as T;
    };
    return response;
  };
  await expect(
    queryBrowserReport('workspace', reportScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl,
    }),
  ).rejects.toThrow('Analytics deadline elapsed');
  expect(provider.queries).toHaveLength(7);
});

it.each([
  { range: '7d' as const },
  { range: '30d' as const },
  { breakdown: 'acquisition' as const },
  { app_id: undefined },
  { environment_id: undefined },
])('preserves original per-call timeouts without a whole-report guard for %j', async (extra) => {
  fixture.seed();
  const filter = { ...reportScope, ...extra };
  const expected = await run(filter);
  const provider = fixture.provider();
  const signals: AbortSignal[] = [];
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const report = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: async (input, init) => {
      signals.push(init!.signal!);
      const response = await provider.fetchImpl(input, init);
      clock = 10001;
      return response;
    },
  });
  expect(report).toEqual(expected.report);
  expect(provider.queries).toEqual(expected.queries);
  expect(new Set(signals).size).toBe(provider.queries.length);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
});
