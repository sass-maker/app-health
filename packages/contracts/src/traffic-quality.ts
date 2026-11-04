import { z } from 'zod';

export const TrafficQualityQuery = z
  .object({
    app_id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    environment_id: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
    from: z.coerce.number().int().nonnegative().safe(),
    to: z.coerce.number().int().positive().safe(),
  })
  .strict();
export type TrafficQualityQuery = z.infer<typeof TrafficQualityQuery>;

export const TrafficQuality = z
  .object({
    app_id: z.string(),
    environment_id: z.string(),
    from: z.number().int().nonnegative(),
    to: z.number().int().positive(),
    generated_at: z.number().int().positive(),
    time_basis: z.literal('receipt_time'),
    qa_internal: z.literal('not_separately_identified'),
    bots: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('observed'),
          pageview_attempts: z.number().int().positive().safe(),
          cloudflare_verified: z.number().int().nonnegative().safe(),
          recognized_user_agent: z.number().int().nonnegative().safe(),
          estimated: z.boolean(),
          coverage: z.literal('partial'),
        })
        .strict()
        .refine(
          (bots) =>
            bots.pageview_attempts === bots.cloudflare_verified + bots.recognized_user_agent,
          'Detector counts must match the observed total',
        ),
      z
        .object({
          status: z.literal('unknown'),
          reason: z.enum([
            'local',
            'unavailable',
            'no_records',
            'invalid_response',
            'index_too_long',
          ]),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((report) => report.from < report.to, 'Report window must increase');
export type TrafficQuality = z.infer<typeof TrafficQuality>;
