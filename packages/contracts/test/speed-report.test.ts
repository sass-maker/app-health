import { describe, expect, it } from 'vitest';
import {
  SpeedReportQuery,
  SpeedReportV1,
  SERVER_TIME_BUDGETS_MS,
  WEB_VITAL_BUDGETS,
} from '../src/index.js';

function report() {
  return {
    range: '24h',
    class: 'app',
    generated_at: 1,
    budgets: { vitals: WEB_VITAL_BUDGETS.app, server: SERVER_TIME_BUDGETS_MS.api.read },
    min_samples: { vitals: 50, server: 30, alert_window: 30 },
    products: [
      {
        catalog_id: 'a',
        app_id: 'app-a',
        name: 'Alpha',
        state: 'no_data',
        vitals: { samples: 0, truncated: false, routes: [] },
        server: { samples: 0, truncated: false, routes: [] },
        rejected: 0,
      },
    ],
    summary: { measured: 0, no_data: 1, insufficient: 0, breaching: 0 },
  };
}

describe('speed report contracts', () => {
  it('defaults queries and parses every supported range/class', () => {
    expect(SpeedReportQuery.parse({})).toEqual({ range: '24h', class: 'app' });
    for (const range of ['1h', '24h', '7d'])
      for (const performanceClass of ['landing', 'app', 'api'])
        expect(SpeedReportQuery.parse({ range, class: performanceClass, app_id: 'app-a' })).toEqual(
          { range, class: performanceClass, app_id: 'app-a' },
        );
    for (const input of [
      { range: '30d' },
      { class: 'job' },
      { app_id: '' },
      { app_id: 'a'.repeat(101) },
      { extra: true },
    ])
      expect(SpeedReportQuery.safeParse(input).success).toBe(false);
  });

  it('parses a bounded strict report and rejects invalid shape, counts and unknown props', () => {
    const input = report();
    expect(SpeedReportV1.parse(input)).toEqual(input);
    const invalid = [
      { ...input, generated_at: -1 },
      { ...input, class: 'job' },
      { ...input, products: Array(57).fill(input.products[0]) },
      { ...input, summary: { ...input.summary, measured: 0.5 } },
      { ...input, products: [{ ...input.products[0], state: 'unknown' }] },
      { ...input, products: [{ ...input.products[0], rejected: -1 }] },
      { ...input, props: { private: true } },
    ];
    for (const value of invalid) expect(SpeedReportV1.safeParse(value).success).toBe(false);
    expect(
      SpeedReportV1.parse({ ...input, class: 'api', budgets: { ...input.budgets, vitals: null } })
        .budgets.vitals,
    ).toBeNull();
  });

  it('validates route percentiles, cache ratios, stage names and route/colo bounds', () => {
    const input = report();
    const route = {
      route: '/api/items/:id',
      samples: 30,
      error_rate: 0.1,
      total_ms: { p50: 50, p95: 100, p99: 200 },
      cache: {
        HIT: 30,
        MISS: 0,
        EXPIRED: 0,
        BYPASS: 0,
        DYNAMIC: 0,
        STALE: 0,
        REVALIDATED: 0,
        NONE: 0,
        hit_ratio: 1,
      },
      colos: [{ colo: 'BOM', samples: 30, p95_ms: 100 }],
      stages_p95_ms: { db_ms: 20 },
      breaches: [{ metric: 'total_ms.p95', value: 501, budget: 500 }],
      sustained: 'breach',
    };
    const withRoutes = (routes: unknown[]) => ({
      ...input,
      products: [{ ...input.products[0], server: { samples: 30, truncated: false, routes } }],
    });
    expect(SpeedReportV1.safeParse(withRoutes([route])).success).toBe(true);
    for (const invalid of [
      { ...route, error_rate: 1.1 },
      { ...route, cache: { ...route.cache, hit_ratio: -1 } },
      { ...route, total_ms: { ...route.total_ms, p95: Infinity } },
      { ...route, stages_p95_ms: { private: 10 } },
      { ...route, colos: Array(6).fill(route.colos[0]) },
      { ...route, props: {} },
    ])
      expect(SpeedReportV1.safeParse(withRoutes([invalid])).success).toBe(false);
    expect(SpeedReportV1.safeParse(withRoutes(Array(26).fill(route))).success).toBe(false);
    const vital = {
      route_group: '/',
      samples: 1,
      lcp_ms: { p75: 0 },
      inp_ms: null,
      ttfb_ms: null,
      cls_milli: null,
      breaches: [],
      sustained: 'insufficient',
    };
    expect(
      SpeedReportV1.safeParse({
        ...input,
        products: [
          { ...input.products[0], vitals: { samples: 1, truncated: false, routes: [vital] } },
        ],
      }).success,
    ).toBe(true);
  });
});
