import { z } from 'zod';
import { BrowserReportFilter } from './browser.js';
import { ProductEventName, ProductPropertyKey } from './product-event.js';

const scalar = z.union([
  z.string().max(255),
  z.number().finite().min(-1e12).max(1e12),
  z.boolean(),
]);
const property = ProductPropertyKey;
export const AnalysisStep = z
  .object({
    type: z.enum(['page', 'event']),
    target: z.string().min(1).max(256),
    property: property.optional(),
    equals: scalar.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    const valid =
      step.type === 'page'
        ? /^\/[^?#@\\\s]*$/.test(step.target) && !step.target.replace(/\/\*$/, '').includes('*')
        : ProductEventName.safeParse(step.target).success;
    if (!valid)
      context.addIssue({
        code: 'custom',
        message: 'Use an event name, page path, or /path/* prefix.',
      });
    if (
      (step.property === undefined) !== (step.equals === undefined) ||
      (step.type === 'page' && step.property !== undefined)
    )
      context.addIssue({
        code: 'custom',
        message: 'Property conditions require an event, a property and a scalar value.',
      });
  });
export type AnalysisStep = z.infer<typeof AnalysisStep>;

export const AnalysisSegment = z
  .object(BrowserReportFilter.shape)
  .pick({
    country: true,
    source: true,
    path: true,
    entry_path: true,
    device: true,
    browser: true,
    channel: true,
    campaign: true,
    medium: true,
    content: true,
    term: true,
  })
  .strict();

const name = z.string().trim().min(1).max(80);
export const AnalysisDefinition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('goal'), name, step: AnalysisStep }).strict(),
  z
    .object({
      kind: z.literal('funnel'),
      name,
      steps: z.array(AnalysisStep).min(2).max(8),
      window_ms: z
        .number()
        .int()
        .min(1000)
        .max(7 * 86400000)
        .default(86400000),
      segment: AnalysisSegment.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('segment'), name, filters: AnalysisSegment }).strict(),
]);
export type AnalysisDefinition = z.infer<typeof AnalysisDefinition>;
export const AnalysisRecord = z
  .object({
    id: z.string().uuid(),
    definition: AnalysisDefinition,
    created_at: z.number().int().nonnegative(),
    updated_at: z.number().int().nonnegative(),
  })
  .strict();
export type AnalysisRecord = z.infer<typeof AnalysisRecord>;
export const AnalysisRecords = z.object({ records: z.array(AnalysisRecord).max(100) }).strict();
export const AnalysisScope = z
  .object({
    app_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    environment_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  })
  .strict();
export type AnalysisScope = z.infer<typeof AnalysisScope>;
export const AnalysisQuery = AnalysisScope.extend({
  range: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  event: ProductEventName.optional(),
  filters: AnalysisSegment.optional(),
}).strict();
export type AnalysisQuery = z.infer<typeof AnalysisQuery>;

const count = z.number().int().nonnegative();
const rate = z.number().min(0).max(1).nullable();
const trackedMoney = z
  .array(
    z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        amount_minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  )
  .max(200);
export const AnalysisReport = z
  .object({
    from: count,
    to: count,
    source: z.enum(['local', 'archive']),
    complete: z.boolean(),
    coverage_note: z.string().max(500),
    events: count,
    sessions: count,
    visitors: count,
    unidentified_sessions: count,
    browser_cohort_visitors: count.optional(),
    unlinked_events: count.optional(),
    tracked_revenue: trackedMoney.optional(),
    conflicting_events: count.optional(),
    property_detail: z.object({ truncated: z.boolean(), omitted_occurrences: count }).optional(),
    values: z.array(z.object({ name: z.string(), occurrences: count, value: z.number().finite() })),
    properties: z.array(
      z.object({ key: z.string(), values: z.array(z.object({ value: scalar, count })) }),
    ),
    goals: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        occurrences: count,
        denominator_visitors: count.optional(),
        rate_visitors: count.optional(),
        unlinked_visitors: count.optional(),
        tracked_revenue: trackedMoney.optional(),
        visitors: count,
        sessions: count,
        conversion_rate: rate,
        value: z.number().finite(),
      }),
    ),
    funnels: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        steps: z.array(
          z.object({ target: z.string(), sessions: count, dropoff: count, conversion_rate: rate }),
        ),
        conversion_rate: rate,
        median_conversion_ms: count.nullable(),
      }),
    ),
  })
  .strict();
export type AnalysisReport = z.infer<typeof AnalysisReport>;
