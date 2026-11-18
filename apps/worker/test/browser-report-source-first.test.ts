import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserReportFilter } from '@app-health/contracts';
import { queryBrowserReport } from '../src/browser-report-query.js';
import { browserReportPlan } from '../src/browser-report-plan.js';
import { reportWindow } from '../src/browser-report-window.js';
import { rankingFixture, reportNow, reportScope } from './ranking-report-fixture.js';

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
const isJoint = (sql: string) => sql.includes('GROUP BY event_kind');
function plan(filter: BrowserReportFilter = reportScope) {
  const { from, to, step } = reportWindow(filter, reportNow);
  return browserReportPlan('workspace', filter, from, to, step, ['app']);
}
type SourceRow = { name: string; count: number; sample_interval: number };
async function withSources(rows: SourceRow[], filter: BrowserReportFilter = reportScope) {
  const selected = plan(filter);
  const provider = fixture.provider();
  const queries: string[] = [];
  const timings: NonNullable<Parameters<typeof queryBrowserReport>[2]['timings']> = {};
  const report = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    timings,
    fetchImpl: async (input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      return sql === selected.sql[2]
        ? Response.json({ data: rows })
        : provider.fetchImpl(input, init);
    },
  });
  return { report, queries, timings };
}

it.each([{}, { source: 'google.com' }])(
  'starts original source SQL before the first reply and before optional queries for %j',
  async (segment) => {
    fixture.seed();
    const filter = { ...reportScope, ...segment };
    const selected = plan(filter);
    const provider = fixture.provider();
    const dispatches: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = queryBrowserReport('workspace', filter, {
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
      expect(dispatches).toEqual([
        selected.sql[0],
        selected.sql[1],
        selected.sql[2],
        selected.sql[4],
        selected.jointSql,
        ...('source' in segment ? [] : selected.sql.slice(-2)),
      ]);
      expect(dispatches.filter((sql) => sql === selected.sql[2])).toHaveLength(1);
    } finally {
      release();
      await pending;
    }
  },
);

it('uses the original source output even when no joint tuple contains that source', async () => {
  fixture.seed();
  const rows = [{ name: 'original-control.example', count: 5, sample_interval: 1 }];
  const original = await withSources(rows, { ...reportScope, app_id: undefined });
  const candidate = await withSources(rows);
  expect(candidate.report).toEqual(original.report);
  expect(candidate.report.sources).toEqual([{ name: rows[0].name, count: 5 }]);
  expect(candidate.queries).toHaveLength(7);
  expect(candidate.timings.analyticsJointFallbacks).toBeUndefined();
  const joint = candidate.queries.find(isJoint)!;
  expect(joint).not.toMatch(/source_name|source_value|source_host|blob10|blob6/);
});

it.each([1, 2])(
  'preserves tied original source order and sample interval%i without a source cutoff guard',
  async (sample) => {
    for (let i = 0; i < 30; i++) fixture.add({ blob10: `host${i}.example`, blob4: `/page${i}` });
    const rows = Array.from({ length: 20 }, (_, i) => ({
      name: `host${29 - i}.example`,
      count: 1,
      sample_interval: sample,
    }));
    const original = await withSources(rows, { ...reportScope, app_id: undefined });
    const candidate = await withSources(rows);
    expect(candidate.report).toEqual(original.report);
    expect(candidate.report.sources).toEqual(rows.map(({ name, count }) => ({ name, count })));
    expect(candidate.report.sampled).toBe(sample > 1);
    expect(candidate.queries).toHaveLength(7);
    expect(candidate.timings.analyticsJointFallbacks).toBeUndefined();
  },
);

it.each(['headers', 'body'] as const)(
  'aborts pending joint %s on mandatory source failure without dispatching fallback or leaking timers',
  async (mode) => {
    fixture.seed();
    vi.useFakeTimers();
    const selected = plan();
    const provider = fixture.provider();
    const queries: string[] = [];
    const signals: AbortSignal[] = [];
    let cancelled = false;
    let releaseHeaders!: (response: Response) => void;
    const pending = queryBrowserReport('workspace', reportScope, {
      accountId: 'a'.repeat(32),
      token: 'synthetic',
      appIds: ['app'],
      fetchImpl: async (input, init) => {
        const sql = String(init?.body);
        queries.push(sql);
        signals.push(init!.signal!);
        if (sql === selected.sql[2]) return new Response(null, { status: 503 });
        if (isJoint(sql))
          return mode === 'headers'
            ? new Promise<Response>((resolve) => {
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
    });
    await expect(pending).rejects.toThrow('event reports unavailable');
    if (mode === 'headers')
      releaseHeaders(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    await vi.advanceTimersByTimeAsync(10000);
    expect(queries).toHaveLength(7);
    expect(new Set(queries).size).toBe(7);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);
