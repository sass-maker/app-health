import { z } from 'zod';
import { ReportDate } from './daily-engagement.js';

export const SpeedReportQuery = z
  .object({
    range: z.enum(['1h', '24h', '7d']).default('24h'),
    app_id: z.string().min(1).max(100).optional(),
    class: z.enum(['landing', 'app', 'api']).default('app'),
  })
  .strict();
export type SpeedReportQuery = z.infer<typeof SpeedReportQuery>;

const count = z.number().int().nonnegative();
const value = z.number().finite().nonnegative();
const p75 = z.object({ p75: value }).strict();
const serverPercentiles = z.object({ p50: value, p95: value, p99: value }).strict();
const vitalMetrics = {
  lcp_ms: p75.nullable(),
  inp_ms: p75.nullable(),
  ttfb_ms: p75.nullable(),
  cls_milli: p75.nullable(),
};
const sustained = z.enum(['breach', 'ok', 'insufficient']);
const breaches = z.array(
  z
    .object({
      metric: z.enum([
        'lcp_ms',
        'inp_ms',
        'ttfb_ms',
        'cls_milli',
        'total_ms.p50',
        'total_ms.p95',
        'total_ms.p99',
      ]),
      value,
      budget: value,
    })
    .strict(),
);
const vitalRoute = z
  .object({
    route_group: z.string().regex(/^\/[a-z0-9_-]{0,40}$/),
    samples: count,
    ...vitalMetrics,
    breaches,
    sustained,
  })
  .strict();
const serverRoute = z
  .object({
    route: z.string().startsWith('/').max(120),
    samples: count,
    error_rate: z.number().min(0).max(1),
    total_ms: serverPercentiles,
    cache: z
      .object({
        HIT: count,
        MISS: count,
        EXPIRED: count,
        BYPASS: count,
        DYNAMIC: count,
        STALE: count,
        REVALIDATED: count,
        NONE: count,
        hit_ratio: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    colos: z
      .array(z.object({ colo: z.string().max(8), samples: count, p95_ms: value }).strict())
      .max(5),
    stages_p95_ms: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}_ms$/), value),
    breaches,
    sustained,
  })
  .strict();
const product = z
  .object({
    catalog_id: z.string().min(1).max(100),
    app_id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    state: z.enum(['measured', 'no_data', 'insufficient']),
    vitals: z
      .object({ samples: count, truncated: z.boolean(), routes: z.array(vitalRoute).max(25) })
      .strict(),
    server: z
      .object({ samples: count, truncated: z.boolean(), routes: z.array(serverRoute).max(25) })
      .strict(),
    rejected: count,
  })
  .strict();

export const SpeedReportV1 = z
  .object({
    range: SpeedReportQuery.shape.range.removeDefault(),
    generated_at: count,
    class: SpeedReportQuery.shape.class.removeDefault(),
    budgets: z
      .object({
        vitals: z.object(vitalMetrics).strict().nullable(),
        server: serverPercentiles,
      })
      .strict(),
    min_samples: z.object({ vitals: count, server: count, alert_window: count }).strict(),
    products: z.array(product).max(56),
    summary: z
      .object({ measured: count, no_data: count, insufficient: count, breaching: count })
      .strict(),
  })
  .strict();
export type SpeedReportV1 = z.infer<typeof SpeedReportV1>;

/** Optional sibling of the strict daily engagement report, never a report field. */
export const DailySpeedSectionV1 = z
  .object({
    date: ReportDate,
    from: count,
    to: count,
    class: SpeedReportQuery.shape.class.removeDefault(),
    products: z
      .array(
        z
          .object({
            catalog_id: product.shape.catalog_id,
            app_id: product.shape.app_id,
            state: product.shape.state,
            vitals_samples: count,
            lcp_p75_ms: value.nullable(),
            inp_p75_ms: value.nullable(),
            cls_p75_milli: value.nullable(),
            ttfb_p75_ms: value.nullable(),
            server_samples: count,
            server_p50_ms: value.nullable(),
            server_p95_ms: value.nullable(),
            server_p99_ms: value.nullable(),
            error_rate: z.number().min(0).max(1).nullable(),
            cache_hit_ratio: z.number().min(0).max(1).nullable(),
            breaching_routes: count,
            worst_route: serverRoute.shape.route.nullable(),
          })
          .strict(),
      )
      .max(56),
    summary: SpeedReportV1.shape.summary,
    truncated: z.boolean(),
  })
  .strict();
export type DailySpeedSectionV1 = z.infer<typeof DailySpeedSectionV1>;
