import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserReportFilter } from '@app-health/contracts';
import { queryBrowserReport } from '../src/browser-report-query.js';
import {
  rankingFixture,
  reportNow,
  reportScope,
  isJoint,
  isPeriods,
  isPages,
  observable,
} from './ranking-report-fixture.js';

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
  const provider = fixture.provider({ first: 'trend', ...config });
  const timings = {};
  const report = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    fetchImpl: provider.fetchImpl,
    timings,
  });
  return { report, timings, ...provider };
}

it('uses the already-ready trend when pages beat the slower current-period aggregate', async () => {
  fixture.seed();
  const { report, queries, timings } = await run();
  expect(report.series.reduce((sum, row) => sum + row.pageviews + row.events, 0)).toBe(8);
  expect(queries).toHaveLength(6);
  expect(queries.filter(isJoint)).toHaveLength(1);
  expect(timings).toMatchObject({ analyticsJointAttempts: 1 });
  expect(observable(report.events)).toEqual([
    { name: 'opened', count: 2, last_seen: reportNow - 800 },
    { name: 'Unknown', count: 1, last_seen: reportNow - 700 },
  ]);
});

it.each([
  { range: '1h' as const },
  { range: '24h' as const, breakdown: 'technology' as const },
  { range: '24h' as const, source: 'Unknown' },
  { range: '24h' as const, source: 'google.com', breakdown: 'technology' as const },
  { range: '24h' as const, event: 'opened' },
])('retains full original SQL results and scope for a trend-first report %j', async (extra) => {
  fixture.seed();
  const filter = { ...reportScope, ...extra };
  const original = await run(filter, { first: 'pages' });
  const candidate = await run(filter);
  expect(observable(candidate.report)).toEqual(observable(original.report));
  expect(candidate.queries).toHaveLength(extra.source || extra.event ? 4 : 6);
  expect(candidate.queries.filter(isPages)).toHaveLength(1);
  for (const sql of candidate.queries) {
    expect(sql).toContain("index1 = 'workspace'");
    expect(sql).toContain("blob1 = 'app'");
    expect(sql).toContain("blob2 = 'env'");
  }
});

it.each([0, 1, 20, 21])('uses only exact current trend totals for %i rows', async (current) => {
  for (let i = 0; i < current; i++) fixture.add();
  for (let i = 0; i < 50; i++) fixture.add({ double2: reportNow - 90_000_000 });
  const result = await run();
  expect(result.report.previous?.pageviews).toBe(50);
  expect(result.queries).toHaveLength(current > 0 && current <= 20 ? 6 : 10);
});

it.each([1.25, 3])(
  'retains the original weighted report for a sampled trend %s',
  async (sample) => {
    fixture.seed();
    fixture.database.prepare('UPDATE app_health_browser_v1 SET _sample_interval=?').run(sample);
    const original = await run(reportScope, { first: 'pages' });
    const candidate = await run();
    expect(observable(candidate.report)).toEqual(observable(original.report));
    expect(candidate.report.sampled).toBe(true);
    expect(candidate.queries).toHaveLength(10);
  },
);

it.each([{ pageviews: 6 }, { sample_interval: 1.25 }, { sample_interval: null }])(
  'falls back once when the eventual current period disagrees: %j',
  async (change) => {
    fixture.seed();
    const transform = (sql: string, rows: Record<string, unknown>[]) =>
      isPeriods(sql)
        ? rows.map((row) => (Number(row.period) === 1 ? { ...row, ...change } : row))
        : rows;
    const original = await run(reportScope, { first: 'pages', transform });
    const candidate = await run(reportScope, { transform });
    expect(observable(candidate.report)).toEqual(observable(original.report));
    expect(candidate.queries).toHaveLength(11);
    expect(candidate.queries.filter(isPages)).toHaveLength(1);
    expect(candidate.timings).toMatchObject({
      analyticsJointAttempts: 1,
      analyticsJointFallbacks: 1,
    });
  },
);

it('does not infer a missing current period as a measured zero after a trend decision', async () => {
  fixture.seed();
  const transform = (sql: string, rows: Record<string, unknown>[]) =>
    isPeriods(sql) ? rows.filter((row) => Number(row.period) !== 1) : rows;
  const original = await run(reportScope, { first: 'pages', transform });
  const candidate = await run(reportScope, { transform });
  expect(observable(candidate.report)).toEqual(observable(original.report));
  expect(candidate.queries).toHaveLength(11);
  expect(candidate.timings).toHaveProperty('analyticsJointFallbacks', 1);
});

it.each([{ sample_interval: null }, { sample_interval: 1.25 }, { pageviews: 5.5 }])(
  'does not speculate from unqualified trend fields %j',
  async (change) => {
    fixture.seed();
    const transform = (sql: string, rows: Record<string, unknown>[]) =>
      sql.includes('GROUP BY bucket') ? rows.map((row) => ({ ...row, ...change })) : rows;
    const original = await run(reportScope, { first: 'pages', transform });
    const candidate = await run(reportScope, { transform });
    expect(observable(candidate.report)).toEqual(observable(original.report));
    expect(candidate.queries).toHaveLength(10);
    expect(candidate.queries.some(isJoint)).toBe(false);
  },
);

it('retains one deadline if the current period arrives after a trend-started joint query', async () => {
  fixture.seed();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const provider = fixture.provider({
    first: 'trend',
    transform: (sql, rows) => {
      if (isPeriods(sql)) clock = 10_001;
      return rows;
    },
  });
  await expect(
    queryBrowserReport('workspace', reportScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl: provider.fetchImpl,
    }),
  ).rejects.toThrow('Analytics deadline elapsed');
  expect(provider.queries).toHaveLength(6);
});

it.each([8, 30])(
  'dispatches bounded next work from trend without waiting for pages or periods at %i rows',
  async (count) => {
    for (let i = 0; i < count; i++) fixture.add();
    const provider = fixture.provider({ first: 'same' });
    const releases: Array<() => void> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await provider.fetchImpl(input, init);
      if (isPages(String(init?.body)) || isPeriods(String(init?.body)))
        return new Promise((resolve) => {
          releases.push(() => resolve(response));
        });
      return response;
    };
    const pending = queryBrowserReport('workspace', reportScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      fetchImpl,
    });
    try {
      await vi.waitFor(() => expect(provider.queries).toHaveLength(count <= 20 ? 6 : 10));
      expect(releases).toHaveLength(2);
      expect(provider.queries.some(isJoint)).toBe(count <= 20);
      expect(provider.queries.some((sql) => sql.includes('pageview_sessions'))).toBe(true);
      expect(provider.queries.some((sql) => sql.includes('argMax'))).toBe(true);
    } finally {
      releases.forEach((release) => release());
    }
    const report = await pending;
    expect(report.series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(count);
  },
);
