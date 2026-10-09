import { describe, expect, it } from 'vitest';
import {
  SpeedReportQuery,
  DailySpeedSectionV1,
  DailyEngagementReportV1,
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

describe('DailySpeedSectionV1', () => {
  const product = {
    catalog_id: 'alpha',
    app_id: 'app-a',
    state: 'no_data',
    vitals_samples: 0,
    lcp_p75_ms: null,
    inp_p75_ms: null,
    cls_p75_milli: null,
    ttfb_p75_ms: null,
    server_samples: 0,
    server_p50_ms: null,
    server_p95_ms: null,
    server_p99_ms: null,
    error_rate: null,
    cache_hit_ratio: null,
    breaching_routes: 0,
    worst_route: null,
  };
  const section = {
    date: '2026-10-09',
    from: 1,
    to: 86_400_001,
    class: 'app',
    products: [product],
    summary: { measured: 0, no_data: 1, insufficient: 0, breaching: 0 },
    truncated: false,
  };

  it('accepts nullable metrics, zeros and each supported class/state', () => {
    expect(DailySpeedSectionV1.parse(section)).toEqual(section);
    for (const state of ['measured', 'no_data', 'insufficient'])
      for (const performanceClass of ['landing', 'app', 'api'])
        expect(
          DailySpeedSectionV1.safeParse({
            ...section,
            class: performanceClass,
            products: [
              {
                ...product,
                state,
                lcp_p75_ms: 0,
                inp_p75_ms: 12.5,
                cls_p75_milli: 0,
                ttfb_p75_ms: 2,
                server_p50_ms: 1,
                server_p95_ms: 2,
                server_p99_ms: 3,
                error_rate: 0,
                cache_hit_ratio: 1,
                breaching_routes: 26,
                worst_route: '/api/items/:id',
              },
            ],
          }).success,
        ).toBe(true);
  });

  it('rejects invalid dates, numbers, bounds and unknown fields at every level', () => {
    for (const input of [
      { ...section, date: '2026-02-30' },
      { ...section, from: -1 },
      { ...section, to: 1.5 },
      { ...section, class: 'job' },
      { ...section, speed: true },
      { ...section, products: Array(57).fill(product) },
      { ...section, summary: { ...section.summary, breaching: -1 } },
      { ...section, summary: { ...section.summary, extra: true } },
    ])
      expect(DailySpeedSectionV1.safeParse(input).success).toBe(false);
    for (const invalid of [
      { state: 'unknown' },
      { vitals_samples: -1 },
      { server_samples: 1.5 },
      { lcp_p75_ms: Infinity },
      { inp_p75_ms: NaN },
      { cls_p75_milli: -1 },
      { error_rate: 1.1 },
      { cache_hit_ratio: -1 },
      { breaching_routes: 0.5 },
      { worst_route: 'raw' },
      { worst_route: '/'.repeat(121) },
      { props: {} },
    ])
      expect(
        DailySpeedSectionV1.safeParse({ ...section, products: [{ ...product, ...invalid }] })
          .success,
      ).toBe(false);
    expect(SpeedReportV1.safeParse({ ...report(), speed: section }).success).toBe(false);
    const daily = {
      schema: 'app-health.daily-engagement.v1',
      schema_version: 1,
      generated_at: 1,
      date: section.date,
      timezone: 'Asia/Kolkata',
      from: section.from,
      to: section.to,
      product_count: 0,
      products: [],
      sampled: false,
      notes: [],
    };
    expect(DailyEngagementReportV1.safeParse(daily).success).toBe(true);
    expect(DailyEngagementReportV1.safeParse({ ...daily, speed: section }).success).toBe(false);
  });
});
