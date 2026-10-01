import { describe, expect, it } from 'vitest';
import { PortfolioBriefingV1 } from '@app-health/contracts';
import { readPortfolioBriefing } from '../src/portfolio-briefing.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const CURRENT_FROM = Date.UTC(2026, 9, 2, 18, 30);

function db(rows: unknown[]): D1DatabaseLike {
  return {
    prepare: (_sql: string) => {
      const statement: D1PreparedStatement = {
        bind: () => statement,
        first: async () => null,
        all: async <T>() => ({ results: rows as T[] }),
        run: async () => ({ success: true, meta: {} }),
      };
      return statement;
    },
    batch: async () => [],
  };
}

const catalog = [
  {
    catalog_id: 'alpha',
    app_id: 'a'.repeat(32),
    catalog_name: 'Alpha',
    environment_id: 'b'.repeat(32),
    analytics_first_received_at: CURRENT_FROM - 86_400_000,
  },
];

const sourceRow = (period: 0 | 1, name: string, pageviews: number, kind = 'source') => ({
  period,
  kind,
  app_id: catalog[0]!.app_id,
  name,
  pageviews,
  visitors: 0,
  sample_interval: 1,
});

function queryWithRows(rows: ReturnType<typeof sourceRow>[]) {
  return async (sql: string) =>
    rows.filter((row) =>
      sql.includes("'baseline' AS kind") ? row.kind === 'baseline' : row.kind === 'source',
    );
}

const briefingArgs = (overrides: Partial<Parameters<typeof readPortfolioBriefing>[0]> = {}) => ({
  db: db(catalog),
  workspaceId: 'workspace-1',
  date: '2026-10-03',
  now: NOW,
  currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 22 }] },
  ...overrides,
});

describe('readPortfolioBriefing', () => {
  it('returns pageview sources and only flags a qualified unsampled breakout', async () => {
    const sql: string[] = [];
    const result = await readPortfolioBriefing({
      db: db(catalog),
      workspaceId: 'workspace-1',
      date: '2026-10-03',
      now: NOW,
      currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 22 }] },
      query: async (query) => {
        sql.push(query);
        return queryWithRows([
          sourceRow(0, 'Google', 12),
          sourceRow(0, 'No referrer', 4),
          sourceRow(1, 'Google', 20),
          sourceRow(1, 'No referrer', 5),
          { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
        ])(query);
      },
    });
    expect(PortfolioBriefingV1.parse(result)).toEqual(result);
    expect(sql).toHaveLength(2);
    expect(sql.every((query) => !query.includes('UNION'))).toBe(true);
    expect(sql.every((query) => query.length <= 10_000)).toBe(true);
    expect(sql.every((query) => query.includes("index1 = 'workspace-1'"))).toBe(true);
    expect(sql[0]).toContain("'No referrer'");
    expect(result.products[0]).toMatchObject({
      pageviews: 25,
      sources_status: 'measured',
      previous_browser_visitors: 10,
      browser_change: 12,
      breakout: true,
    });
    expect(result.products[0]?.top_sources[0]).toMatchObject({ name: 'Google', pageviews: 20 });
    expect(result.sources[0]).toMatchObject({ name: 'Google', pageviews: 20 });
  });

  it('suppresses rollout comparisons and keeps unavailable source data unknown', async () => {
    const result = await readPortfolioBriefing({
      db: db(catalog),
      workspaceId: 'workspace-1',
      date: '2026-10-02',
      now: NOW,
      currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 40 }] },
    });
    expect(result.products[0]).toMatchObject({
      pageviews: null,
      sources_status: 'unknown',
      previous_browser_visitors: null,
      browser_change: null,
      breakout: false,
    });
    expect(result.comparison_note).toContain('Oct 2 is the first fully filtered day');
  });

  it('fails closed when the grouped source result reaches its capacity', async () => {
    const rows = Array.from({ length: 10_000 }, (_, index) => sourceRow(1, `source-${index}`, 1));
    const result = await readPortfolioBriefing({
      db: db(catalog),
      workspaceId: 'workspace-1',
      date: '2026-10-03',
      now: NOW,
      currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 40 }] },
      query: queryWithRows(rows),
    });
    expect(result.products[0]).toMatchObject({ pageviews: null, sources_status: 'unknown' });
    expect(result.products[0]?.breakout).toBe(false);
  });

  it('keeps comparison deltas unknown when source coverage is sampled', async () => {
    const result = await readPortfolioBriefing({
      db: db(catalog),
      workspaceId: 'workspace-1',
      date: '2026-10-03',
      now: NOW,
      currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 40 }] },
      query: queryWithRows([
        { ...sourceRow(0, 'Google', 12), sample_interval: 2 },
        sourceRow(1, 'Google', 30),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
      ]),
    });
    expect(result.products[0]).toMatchObject({
      source_estimated: true,
      previous_browser_visitors: 10,
      browser_change: null,
      breakout: false,
    });
  });

  it('preserves safe custom source domains and collapses unsafe referrer content', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs(),
      query: queryWithRows([
        sourceRow(1, 'github.com', 3),
        sourceRow(1, 'GitHub.com', 2),
        sourceRow(1, 'https://private.example/path?q=x', 4),
        sourceRow(1, 'fleetreferrals', 7),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
      ]),
    });
    expect(result.products[0]?.top_sources).toContainEqual({
      name: 'github.com',
      pageviews: 5,
      share: 5 / 16,
    });
    expect(result.products[0]?.top_sources).toContainEqual({
      name: 'Other referral',
      pageviews: 4,
      share: 4 / 16,
    });
    expect(JSON.stringify(result)).not.toContain('private.example');
    expect(JSON.stringify(result)).toContain('fleetreferrals');
  });

  it('rejects absent aggregate values instead of coercing them to zero', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs(),
      query: async () => [{ ...sourceRow(1, 'Google', 10), sample_interval: null }],
    });
    expect(result.products[0]).toMatchObject({
      pageviews: null,
      sources_status: 'unknown',
      top_sources: [],
      breakout: false,
    });
  });

  it('suppresses comparisons when analytics began partway through the prior day', async () => {
    const partialPriorCatalog = [
      {
        ...catalog[0]!,
        analytics_first_received_at: Date.UTC(2026, 9, 2, 0),
      },
    ];
    const result = await readPortfolioBriefing({
      ...briefingArgs({ db: db(partialPriorCatalog) }),
      query: queryWithRows([
        sourceRow(0, 'Google', 12),
        sourceRow(1, 'Google', 25),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
      ]),
    });
    expect(result.products[0]).toMatchObject({
      pageviews: 25,
      previous_browser_visitors: 10,
      browser_change: null,
      breakout: false,
    });
  });

  it('allows a comparison between two fully pre-cutover days', async () => {
    const beforeCutoverCatalog = [
      {
        ...catalog[0]!,
        analytics_first_received_at: Date.UTC(2026, 8, 27, 18, 30),
      },
    ];
    const result = await readPortfolioBriefing({
      db: db(beforeCutoverCatalog),
      workspaceId: 'workspace-1',
      date: '2026-09-30',
      now: NOW,
      currentReport: { products: [{ app_id: catalog[0]!.app_id, browser_visitors: 22 }] },
      query: queryWithRows([
        sourceRow(0, 'Google', 12),
        sourceRow(1, 'Google', 25),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
      ]),
    });
    expect(result.products[0]).toMatchObject({ browser_change: 12, breakout: true });
  });

  it('keeps the delta but withholds breakout status for a tiny baseline', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs(),
      query: queryWithRows([
        sourceRow(0, 'Google', 12),
        sourceRow(1, 'Google', 25),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 4 },
      ]),
    });
    expect(result.products[0]).toMatchObject({
      previous_browser_visitors: 4,
      browser_change: 18,
      breakout: false,
    });
  });

  it('keeps source totals unknown when an empty query lacks full-day telemetry coverage', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs({
        db: db([{ ...catalog[0]!, analytics_first_received_at: null }]),
      }),
      query: async () => [],
    });
    expect(result.products[0]).toMatchObject({
      pageviews: null,
      top_sources: [],
      sources_status: 'unknown',
    });
  });

  it('queries all 55 production scopes within the Analytics Engine SQL byte budget', async () => {
    const manyCatalog = Array.from({ length: 55 }, (_, index) => ({
      catalog_id: `catalog-${String(index).padStart(2, '0')}-${'c'.repeat(29)}`,
      app_id: `app-${String(index).padStart(2, '0')}-${'a'.repeat(29)}`,
      catalog_name: `Product ${index}`,
      environment_id: `env-${String(index).padStart(2, '0')}-${'b'.repeat(31)}`,
      analytics_first_received_at: CURRENT_FROM - 86_400_000,
    }));
    let calls = 0;
    const queries: string[] = [];
    const result = await readPortfolioBriefing({
      db: db(manyCatalog),
      workspaceId: 'workspace-1',
      date: '2026-10-03',
      now: NOW,
      currentReport: {
        products: manyCatalog.map((row) => ({ app_id: row.app_id, browser_visitors: null })),
      },
      query: async (sql) => {
        calls += 1;
        queries.push(sql);
        return [];
      },
    });
    expect(calls).toBe(2);
    expect(queries).toHaveLength(2);
    expect(queries.every((sql) => new TextEncoder().encode(sql).byteLength <= 10_000)).toBe(true);
    expect(queries.every((sql) => sql.includes("index1 = 'workspace-1'"))).toBe(true);
    expect(queries.every((sql) => sql.includes('blob2 IN ('))).toBe(true);
    expect(queries.every((sql) => !sql.includes('UNION'))).toBe(true);
    expect(result.products).toHaveLength(55);
    expect(result.products.every((row) => row.sources_status === 'measured')).toBe(true);
  });

  it('retains measured current sources when the prior baseline query fails', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs(),
      query: async (sql) => {
        if (sql.includes("'baseline' AS kind")) throw new Error('baseline unavailable');
        return [sourceRow(1, 'github.com', 8)];
      },
    });
    expect(result.products[0]).toMatchObject({
      pageviews: 8,
      sources_status: 'measured',
      top_sources: [{ name: 'github.com', pageviews: 8, share: 1 }],
      previous_browser_visitors: null,
      browser_change: null,
      breakout: false,
    });
  });

  it('omits a not-applicable browser product from traffic totals', async () => {
    const result = await readPortfolioBriefing({
      ...briefingArgs({
        currentReport: {
          products: [
            {
              app_id: catalog[0]!.app_id,
              browser_visitors: null,
              browser_visitors_applicability: 'not_applicable',
            },
          ],
        },
      }),
      query: queryWithRows([
        sourceRow(0, 'Google', 12),
        sourceRow(1, 'Google', 25),
        { ...sourceRow(0, '__baseline__', 0, 'baseline'), visitors: 10 },
      ]),
    });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      pageviews: null,
      top_sources: [],
      sources_status: 'not_applicable',
    });
    expect(result.sources).toEqual([]);
  });
});
