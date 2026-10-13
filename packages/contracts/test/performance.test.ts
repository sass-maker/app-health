import { describe, expect, it } from 'vitest';
import {
  PERFORMANCE_CLASSES,
  WEB_VITAL_BUDGETS,
  MIN_WEB_VITAL_SAMPLES_PER_DAY,
  SERVER_TIME_BUDGETS_MS,
  serverBudgetFor,
  STAGE_TIMING_EVENT,
  STAGE_TIMING_LEVEL,
  StageTimingProps,
  parseStageTiming,
  WEB_VITALS_EVENT,
  WEB_VITALS_LEVEL,
  WebVitalsProps,
  MIN_ALERT_WINDOW_SAMPLES,
  ALERT_WINDOW_MINUTES,
  BREACH_WINDOWS_REQUIRED,
  BREACH_WINDOWS_LOOKBACK,
  RECOVERY_CLEAN_WINDOWS,
  PROBE_CONSECUTIVE_FAILURES,
  PERFORMANCE_ALERT_LEVEL,
  evaluateSustainedBreach,
} from '../src/index.js';

function stageTiming(overrides: Record<string, unknown> = {}) {
  return {
    route: '/api/articles/:id',
    status: 200,
    total_ms: 120,
    edge_cache: 'MISS',
    inner_cache: 'HIT',
    ...overrides,
  };
}

describe('stage timing props', () => {
  it('accepts templates, applies the colo default, and preserves stage timings', () => {
    const props: StageTimingProps = {
      route: '/',
      status: 200,
      total_ms: 0,
      edge_cache: 'NONE',
      inner_cache: 'NONE',
      colo: 'unknown',
      db_ms: 0,
    };
    expect(StageTimingProps.parse(props)).toEqual(props);
    const result = parseStageTiming(stageTiming({ db_ms: 40, render_ms: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value).toMatchObject({ colo: 'unknown', db_ms: 40, render_ms: 0 });
    expect(
      StageTimingProps.safeParse(
        stageTiming({ route: '/', colo: 'BOM', cold: 1, release: 'v1.2-rc_1', total_ms: 600_000 }),
      ).success,
    ).toBe(true);
    for (const cache of [
      'HIT',
      'MISS',
      'EXPIRED',
      'BYPASS',
      'DYNAMIC',
      'STALE',
      'REVALIDATED',
      'NONE',
    ]) {
      expect(parseStageTiming(stageTiming({ edge_cache: cache, inner_cache: cache })).ok).toBe(
        true,
      );
    }
  });

  it('rejects concrete ids, query strings, fragments, whitespace, and oversized routes', () => {
    for (const route of [
      'api/articles',
      '/api/articles/123',
      '/api/articles/11111111-2222-4333-a444-555555555555',
      '/api/articles/ABCDEF0123456789',
      '/api/articles?q=private',
      '/api/articles#private',
      '/api/a b',
      '/api/a\nb',
      '/api/articles\n',
      `/${'a'.repeat(120)}`,
    ]) {
      expect(parseStageTiming(stageTiming({ route })).ok, route).toBe(false);
    }
  });

  it('rejects unknown keys, malformed stage keys, and more than 20 stages', () => {
    for (const key of ['unknown', 'db', 'Db_ms', '1db_ms', 'db-ms', `${'a'.repeat(33)}_ms`]) {
      expect(parseStageTiming(stageTiming({ [key]: 10 })).ok, key).toBe(false);
    }
    const stages = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`stage_${i}_ms`, i]));
    expect(parseStageTiming(stageTiming(stages)).ok).toBe(true);
    expect(parseStageTiming(stageTiming({ ...stages, extra_ms: 1 })).ok).toBe(false);
    expect(parseStageTiming(stageTiming({ [`${'a'.repeat(32)}_ms`]: 10 })).ok).toBe(true);
  });

  it('bounds field values and reports validation errors', () => {
    for (const props of [
      { edge_cache: 'hit' },
      { inner_cache: 'UNKNOWN' },
      { status: 99 },
      { status: 600 },
      { status: 200.5 },
      { total_ms: -1 },
      { total_ms: 600_001 },
      { db_ms: Infinity },
      { db_ms: NaN },
      { db_ms: -1 },
      { db_ms: 600_001 },
      { db_ms: '10' },
      { colo: 'us-east-1' },
      { cold: 2 },
      { release: 'bad release' },
      { release: 'a'.repeat(65) },
    ]) {
      const result = parseStageTiming(stageTiming(props));
      expect(result.ok, JSON.stringify(props)).toBe(false);
      if (!result.ok) expect(result.error.issues.length).toBeGreaterThan(0);
    }
    expect(parseStageTiming(null).ok).toBe(false);
  });
});

describe('web vital props', () => {
  it('accepts each navigation type and metric, including zero', () => {
    for (const nav_type of ['navigate', 'reload', 'back_forward', 'prerender', 'restore']) {
      for (const metric of ['lcp_ms', 'inp_ms', 'ttfb_ms', 'cls_milli']) {
        expect(WebVitalsProps.safeParse({ route_group: '/', nav_type, [metric]: 0 }).success).toBe(
          true,
        );
      }
    }
    expect(
      WebVitalsProps.safeParse({
        route_group: '/article_template',
        nav_type: 'navigate',
        lcp_ms: 600_000,
        inp_ms: 200,
        ttfb_ms: 600,
        cls_milli: 10_000,
      }).success,
    ).toBe(true);
  });

  it('rejects missing metrics, unsafe groups, unknown fields, and invalid metric values', () => {
    const base = { route_group: '/articles', nav_type: 'navigate', lcp_ms: 1000 };
    for (const route_group of [
      '/123',
      '/11111111-2222-4333-a444-555555555555',
      '/abcdef0123456789',
      '/articles/child',
      '/articles?q=x',
      '/articles#x',
      '/a b',
      '/articles\n',
      `/${'a'.repeat(41)}`,
    ]) {
      expect(WebVitalsProps.safeParse({ ...base, route_group }).success, route_group).toBe(false);
    }
    const bad: unknown[] = [
      { route_group: '/', nav_type: 'navigate' },
      { ...base, nav_type: 'unknown' },
      { ...base, extra: 1 },
      { ...base, lcp_ms: undefined },
      { ...base, lcp_ms: -1 },
      { ...base, inp_ms: Infinity },
      { ...base, ttfb_ms: 600_001 },
      { ...base, cls_milli: 0.5 },
      { ...base, cls_milli: 10_001 },
    ];
    for (const props of bad) expect(WebVitalsProps.safeParse(props).success).toBe(false);
  });
});

describe('performance budgets and event constants', () => {
  it('defines class-specific p75 web and API server budgets', () => {
    expect(PERFORMANCE_CLASSES).toEqual(['landing', 'app', 'api', 'job']);
    expect(WEB_VITAL_BUDGETS).toEqual({
      landing: {
        lcp_ms: { p75: 2000 },
        inp_ms: { p75: 200 },
        cls_milli: { p75: 100 },
        ttfb_ms: { p75: 600 },
      },
      app: {
        lcp_ms: { p75: 2500 },
        inp_ms: { p75: 200 },
        cls_milli: { p75: 100 },
        ttfb_ms: { p75: 800 },
      },
    });
    expect(serverBudgetFor('api', 'read')).toEqual({ p50: 150, p95: 500, p99: 1500 });
    expect(serverBudgetFor('api', 'write')).toEqual({ p95: 800 });
    expect(serverBudgetFor('api', 'read')).toBe(SERVER_TIME_BUDGETS_MS.api.read);
    for (const performanceClass of ['landing', 'app', 'job'] as const) {
      expect(serverBudgetFor(performanceClass, 'read')).toBeNull();
      expect(serverBudgetFor(performanceClass, 'write')).toBeNull();
    }
    expect(MIN_WEB_VITAL_SAMPLES_PER_DAY).toBe(50);
    expect([STAGE_TIMING_EVENT, STAGE_TIMING_LEVEL]).toEqual(['api.stage_timing', 'debug']);
    expect([WEB_VITALS_EVENT, WEB_VITALS_LEVEL]).toEqual(['web.vitals', 'debug']);
    expect(PERFORMANCE_ALERT_LEVEL).toBe('warn');
  });
});

describe('sustained performance breaches', () => {
  const clean = { samples: MIN_ALERT_WINDOW_SAMPLES, value: 500 };
  const spike = { samples: MIN_ALERT_WINDOW_SAMPLES, value: 501 };
  const insufficient = { samples: MIN_ALERT_WINDOW_SAMPLES - 1, value: 1000 };

  it('uses 15-minute windows, 3 of 4 breaches, 4 clean windows, and 3 probe failures', () => {
    expect(ALERT_WINDOW_MINUTES).toBe(15);
    expect(MIN_ALERT_WINDOW_SAMPLES).toBe(30);
    expect(BREACH_WINDOWS_REQUIRED).toBe(3);
    expect(BREACH_WINDOWS_LOOKBACK).toBe(4);
    expect(RECOVERY_CLEAN_WINDOWS).toBe(4);
    expect(PROBE_CONSECUTIVE_FAILURES).toBe(3);
  });

  it('never alerts on a single spike and preserves a previous ok state', () => {
    expect(evaluateSustainedBreach([clean, clean, spike, clean], 500)).toBe('insufficient');
    expect(evaluateSustainedBreach([clean, clean, spike, clean], 500, 'ok')).toBe('ok');
    expect(evaluateSustainedBreach([spike], 500)).toBe('insufficient');
    expect(evaluateSustainedBreach(Array(4).fill(insufficient), 500, 'ok')).toBe('insufficient');
  });

  it('breaches on 3 of the last 4 sufficient windows and ignores older spikes', () => {
    expect(evaluateSustainedBreach([spike, clean, spike, spike], 500)).toBe('breach');
    expect(evaluateSustainedBreach([spike, insufficient, spike, spike], 500)).toBe('breach');
    expect(evaluateSustainedBreach([spike, spike, spike, clean, clean, clean, clean], 500)).toBe(
      'ok',
    );
  });

  it('keeps an active breach through partial recovery and missing samples', () => {
    expect(evaluateSustainedBreach([spike, clean, clean, clean], 500, 'breach')).toBe('breach');
    expect(evaluateSustainedBreach([clean, clean, clean], 500, 'breach')).toBe('breach');
    expect(evaluateSustainedBreach([clean, insufficient, clean, clean], 500, 'breach')).toBe(
      'breach',
    );
    expect(evaluateSustainedBreach([], 500, 'breach')).toBe('breach');
  });

  it('never decides ok or breach from insufficient samples alone', () => {
    expect(evaluateSustainedBreach([], 500)).toBe('insufficient');
    expect(evaluateSustainedBreach(Array(4).fill(insufficient), 500)).toBe('insufficient');
    expect(evaluateSustainedBreach(Array(4).fill({ ...insufficient, value: 0 }), 500)).toBe(
      'insufficient',
    );
    expect(evaluateSustainedBreach([spike, spike, insufficient, insufficient], 500)).toBe(
      'insufficient',
    );
  });

  it('recovers after four sufficient clean windows, including equality with the budget', () => {
    const windows = [spike, clean, clean, clean, clean];
    expect(evaluateSustainedBreach(windows, 500, 'breach')).toBe('ok');
    expect(evaluateSustainedBreach(windows, 500)).toBe('ok');
    expect(evaluateSustainedBreach(windows, 500, 'insufficient')).toBe('ok');
  });
});
