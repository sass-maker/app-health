// Bounded owner-only daily engagement report (app-health.daily-engagement.v1).
//
// One completed Asia/Kolkata day across the workspace's declared catalog products. The
// report is a read-only aggregate designed so a later scheduler/delivery
// adapter can reuse the same result. Every metric is honestly bounded: a
// measurable count is a non-negative integer; an unmeasured surface is `null`
// (unknown), never `0`, so "no signal" never reads as "zero engagement".
//
// Privacy: the report carries only counts, canonical IDs, and freshness
// timestamps. It never includes submitted content, email, headers, cookies,
// identities, raw URLs, tokens, or log prop values. Project mapping for
// centralized SaaS Maker logs is resolved to a catalog_id and discarded.

import { z } from 'zod';

export const DAILY_ENGAGEMENT_SCHEMA = 'app-health.daily-engagement.v1' as const;

/** Report calendar date in Asia/Kolkata, YYYY-MM-DD. */
export const ReportDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      Number.isSafeInteger(year) &&
      year >= 2000 &&
      year <= 9999 &&
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, 'valid calendar date');

/** One configured primary call-to-action event count for a product. */
export const DailyCtaEvent = z
  .object({
    name: z.string().min(1).max(64),
    count: z.number().int().min(0),
    /** Distinct recognized browsers that performed this action; unknown when sampled. */
    unique_browsers: z.number().int().min(0).nullable(),
    /** True when Analytics Engine scaled sampled event rows into an estimate. */
    estimated: z.boolean(),
  })
  .strict();
export type DailyCtaEvent = z.infer<typeof DailyCtaEvent>;

/** Measurement freshness for one product across the surfaces that were read. */
export const DailyFreshness = z
  .object({
    browser_last_seen: z.number().int().min(0).nullable(),
    log_last_seen: z.number().int().min(0).nullable(),
  })
  .strict();
export type DailyFreshness = z.infer<typeof DailyFreshness>;

/**
 * One product row. `null` means the surface was not measurable for this
 * product on this day (no binding, no telemetry, or the grouped query did not
 * cover it). Products without a catalog import row are omitted entirely and
 * called out in report notes. A `0` is reported only when the surface was
 * measurable and produced zero events.
 */
export const DailyEngagementProductReportV1 = z
  .object({
    catalog_id: z.string().min(1).max(100),
    app_id: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    /** Browser unique visitors. `null` when browser analytics is unconfigured or unsampled. */
    browser_visitors: z.number().int().min(0).nullable(),
    /** Up to three configured primary CTA event counts. Empty when none were measurable. */
    cta_events: z.array(DailyCtaEvent).max(3),
    /** Distinguishes a measured action, unsupported product form, and missing evidence. */
    cta_status: z.enum(['measured', 'not_applicable', 'unknown']),
    /** Feedback submissions, or an observed App Health log lower bound when source data is unavailable. */
    feedback_submitted: z.number().int().min(0).nullable(),
    /** Newsletter joins, or an observed App Health log lower bound when source data is unavailable. */
    newsletter_joins: z.number().int().min(0).nullable(),
    /** Capture policy applicability, separate from whether a count was measured. */
    newsletter_applicability: z
      .enum(['applicable', 'not_applicable', 'unknown'])
      .default('unknown'),
    /** Waitlist joins, or an observed App Health log lower bound when source data is unavailable. */
    waitlist_joins: z.number().int().min(0).nullable(),
    /** Capture policy applicability, separate from whether a count was measured. */
    waitlist_applicability: z.enum(['applicable', 'not_applicable', 'unknown']).default('unknown'),
    /** Observed native sessions; null when absent, unavailable, or sampled. */
    native_sessions: z.number().int().min(0).nullable(),
    /** Server request count, not people. `null` when durable unsampled endpoint coverage is unknown. */
    api_activity: z.number().int().min(0).nullable(),
    freshness: DailyFreshness,
    /** How much of this product's row was actually measured. */
    coverage: z.enum(['full', 'partial', 'unknown']),
  })
  .strict();
export type DailyEngagementProductReportV1 = z.infer<typeof DailyEngagementProductReportV1>;

export const DailyEngagementReportV1 = z
  .object({
    schema: z.literal(DAILY_ENGAGEMENT_SCHEMA),
    schema_version: z.literal(1),
    generated_at: z.number().int().min(0),
    /** The completed Asia/Kolkata calendar day this report covers. */
    date: ReportDate,
    timezone: z.literal('Asia/Kolkata'),
    /** Inclusive UTC epoch (ms) of local midnight. */
    from: z.number().int().min(0),
    /** Exclusive UTC epoch (ms) of the next local midnight. */
    to: z.number().int().min(0),
    /** Number of declared catalog products in scope. */
    product_count: z.number().int().min(0),
    products: z.array(DailyEngagementProductReportV1),
    /** Whether any browser or native session aggregate was sampled by Analytics Engine. */
    sampled: z.boolean(),
    /** Honest, human-readable caveats for missing coverage. */
    notes: z.array(z.string()),
  })
  .strict();
export type DailyEngagementReportV1 = z.infer<typeof DailyEngagementReportV1>;
