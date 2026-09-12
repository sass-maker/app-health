import { z } from 'zod';

/** Opt-in browser analytics is separate from request/endpoint telemetry. */
export const PRESENCE_TTL_MS = 45_000;
export const BrowserEventV1 = z
  .object({
    event_id: z.string().uuid(),
    timestamp: z.number().int().nonnegative(),
    type: z.enum(['pageview', 'event']),
    path: z
      .string()
      .startsWith('/')
      .max(256)
      .regex(/^[^?#@\\\s]*$/),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_.:-]{0,63}$/)
      .optional(),
    referrer: z
      .string()
      .max(253)
      .regex(/^[a-z0-9.-]*$/i)
      .default(''),
  })
  .strict()
  .refine((event) =>
    event.type === 'pageview' ? event.name === undefined : event.name !== undefined,
  );
export type BrowserEventV1 = z.infer<typeof BrowserEventV1>;

export const BrowserBatchV1 = z
  .object({
    schema_version: z.literal(1),
    batch_id: z.string().uuid(),
    public_key: z.string().startsWith('ahk_pub_').max(256),
    session_id: z.string().uuid(),
    events: z.array(BrowserEventV1).max(25),
  })
  .strict();
export type BrowserBatchV1 = z.infer<typeof BrowserBatchV1>;

export const PresenceSnapshot = z.object({
  measured_at: z.number().finite().nonnegative(),
  ttl_ms: z.literal(PRESENCE_TTL_MS),
  total: z.number().int().min(0).max(20000),
  projects: z
    .array(
      z.object({
        app_id: z.string(),
        environment_id: z.string(),
        active: z.number().int().min(0).max(20000),
      }),
    )
    .max(1000),
});
export type PresenceSnapshot = z.infer<typeof PresenceSnapshot>;
export const BrowserSummary = z
  .object({
    enabled: z.boolean(),
    source: z.enum(['local', 'analytics-engine']),
    sampled: z.boolean(),
    projects: z
      .array(
        z
          .object({
            app_id: z.string(),
            environment_id: z.string(),
            pageviews: z.number().finite().nonnegative(),
            events: z.number().finite().nonnegative(),
            sessions: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(1000),
    live: PresenceSnapshot,
    stream: z.boolean(),
  })
  .strict();
export type BrowserSummary = z.infer<typeof BrowserSummary>;

export const BrowserReportFilter = z
  .object({
    range: z.enum(['1h', '24h']).default('24h'),
    app_id: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,100}$/)
      .optional(),
    environment_id: z
      .string()
      .regex(/^[a-zA-Z0-9-]{1,100}$/)
      .optional(),
    event: z
      .string()
      .regex(/^[a-z][a-z0-9_.:-]{0,63}$/)
      .optional(),
  })
  .strict();
export type BrowserReportFilter = z.infer<typeof BrowserReportFilter>;
export const BrowserReport = z
  .object({
    from: z.number().finite().nonnegative(),
    to: z.number().finite().nonnegative(),
    sampled: z.boolean(),
    source: z.enum(['local', 'analytics-engine']),
    series: z
      .array(
        z
          .object({
            timestamp: z.number().finite().nonnegative(),
            pageviews: z.number().finite().nonnegative(),
            events: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(24),
    pages: z
      .array(z.object({ name: z.string(), count: z.number().finite().nonnegative() }).strict())
      .max(20),
    sources: z
      .array(z.object({ name: z.string(), count: z.number().finite().nonnegative() }).strict())
      .max(20),
    events: z
      .array(
        z
          .object({
            name: z.string(),
            count: z.number().finite().nonnegative(),
            last_seen: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .max(100),
    sessions: z.number().finite().nonnegative(),
  })
  .strict();
export type BrowserReport = z.infer<typeof BrowserReport>;
