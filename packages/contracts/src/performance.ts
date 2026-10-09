// Fleet performance contract. Explicit, privacy-bounded telemetry uses route
// templates and bounded timings; only sustained breaches become incidents.
// The canonical specification lives in docs/performance-contract.md.

import { z } from 'zod';

export const PERFORMANCE_CLASSES = ['landing', 'app', 'api', 'job'] as const;
export type PerformanceClass = (typeof PERFORMANCE_CLASSES)[number];

export const WEB_VITAL_BUDGETS = {
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
} as const;
export const MIN_WEB_VITAL_SAMPLES_PER_DAY = 50;

export const SERVER_TIME_BUDGETS_MS = {
  api: { read: { p50: 150, p95: 500, p99: 1500 }, write: { p95: 800 } },
} as const;

/** Jobs require a per-route budget; other classes have no server default. */
export function serverBudgetFor(performanceClass: PerformanceClass, kind: 'read' | 'write') {
  return performanceClass === 'api' ? SERVER_TIME_BUDGETS_MS.api[kind] : null;
}

export const STAGE_TIMING_EVENT = 'api.stage_timing';
export const STAGE_TIMING_LEVEL = 'debug';
export const WEB_VITALS_EVENT = 'web.vitals';
export const WEB_VITALS_LEVEL = 'debug';

const timingMs = z.number().finite().min(0).max(600_000);
const cacheStatus = z.enum([
  'HIT',
  'MISS',
  'EXPIRED',
  'BYPASS',
  'DYNAMIC',
  'STALE',
  'REVALIDATED',
  'NONE',
]);
const stageKeyPattern = /^[a-z][a-z0-9_]{0,31}_ms$/;
const concreteIdPattern = /^(?:\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;
const hasNoConcreteIds = (route: string) =>
  route.split('/').every((segment) => !concreteIdPattern.test(segment));

const stageTimingFields = {
  route: z
    .string()
    .startsWith('/')
    .max(120)
    .refine(
      (route) => !/[?#\s]/.test(route),
      'route template without query, fragment, or whitespace',
    )
    .refine(hasNoConcreteIds, 'route template without concrete ids'),
  status: z.number().int().min(100).max(599),
  total_ms: timingMs,
  edge_cache: cacheStatus,
  inner_cache: cacheStatus,
  colo: z
    .string()
    .regex(/^[A-Za-z0-9]{1,8}$/)
    .default('unknown'),
  cold: z.union([z.literal(0), z.literal(1)]).optional(),
  release: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
};

const stageTimingBase = z.object(stageTimingFields);
export type StageTimingProps = z.infer<typeof stageTimingBase> &
  Partial<Record<`${string}_ms`, number>>;

export const StageTimingProps = stageTimingBase
  .catchall(timingMs)
  .superRefine((props, ctx) => {
    const stageKeys = Object.keys(props).filter((key) => !Object.hasOwn(stageTimingFields, key));
    for (const key of stageKeys) {
      if (!stageKeyPattern.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'invalid stage key' });
      }
    }
    if (stageKeys.length > 20) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at most 20 stage keys' });
    }
  })
  .transform((props): StageTimingProps => props);

export function parseStageTiming(
  props: unknown,
): { ok: true; value: StageTimingProps } | { ok: false; error: z.ZodError } {
  const parsed = StageTimingProps.safeParse(props);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error };
}

export const WebVitalsProps = z
  .object({
    route_group: z
      .string()
      .regex(/^\/[a-z0-9_-]{0,40}$/)
      .refine(
        (route) => hasNoConcreteIds(route) && !/\s/.test(route),
        'route group without concrete ids or whitespace',
      ),
    nav_type: z.enum(['navigate', 'reload', 'back_forward', 'prerender', 'restore']),
    lcp_ms: timingMs.optional(),
    inp_ms: timingMs.optional(),
    ttfb_ms: timingMs.optional(),
    cls_milli: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  .refine(
    (props) =>
      props.lcp_ms !== undefined ||
      props.inp_ms !== undefined ||
      props.ttfb_ms !== undefined ||
      props.cls_milli !== undefined,
    'at least one web vital metric',
  );
export type WebVitalsProps = z.infer<typeof WebVitalsProps>;

export const MIN_ALERT_WINDOW_SAMPLES = 30;
export const ALERT_WINDOW_MINUTES = 15;
export const BREACH_WINDOWS_REQUIRED = 3;
export const BREACH_WINDOWS_LOOKBACK = 4;
export const RECOVERY_CLEAN_WINDOWS = 4;
export const PROBE_CONSECUTIVE_FAILURES = 3;
// Debug/info perf telemetry never reaches Slack; only sustained breaches create
// in-app 'warn' incidents. Routing enforcement belongs to the consumer.
export const PERFORMANCE_ALERT_LEVEL = 'warn';

export type PerformanceBreachState = 'breach' | 'ok' | 'insufficient';

/** Windows are oldest to newest; value is the window's measured percentile. */
export function evaluateSustainedBreach(
  windows: readonly { samples: number; value: number }[],
  budget: number,
  previous?: PerformanceBreachState,
): PerformanceBreachState {
  const recent = windows.slice(-BREACH_WINDOWS_LOOKBACK);
  const clean = windows.slice(-RECOVERY_CLEAN_WINDOWS);
  const recovered =
    clean.length === RECOVERY_CLEAN_WINDOWS &&
    clean.every((window) => window.samples >= MIN_ALERT_WINDOW_SAMPLES && window.value <= budget);
  if (previous === 'breach') return recovered ? 'ok' : 'breach';
  const breaches = recent.filter(
    (window) => window.samples >= MIN_ALERT_WINDOW_SAMPLES && window.value > budget,
  ).length;
  if (breaches >= BREACH_WINDOWS_REQUIRED) return 'breach';
  if (recovered) return 'ok';
  // Missing data never keeps an earlier 'ok' alive: no sufficient recent window means unknown.
  if (!recent.some((window) => window.samples >= MIN_ALERT_WINDOW_SAMPLES)) return 'insufficient';
  return previous ?? 'insufficient';
}
