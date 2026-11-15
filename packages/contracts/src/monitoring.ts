import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const policyFields = {
  catalog_id: id,
  name: z.string().trim().min(1).max(100),
  scope: z.enum(['public', 'local', 'private']),
  reason: z.string().trim().min(1).max(500).nullable(),
  journeys: z.array(id).max(10),
};
const policyProject = z
  .object(policyFields)
  .strict()
  .refine((row) => new Set(row.journeys).size === row.journeys.length, 'Duplicate journey')
  .refine(
    (row) =>
      row.scope === 'public'
        ? row.journeys.length > 0
        : row.reason !== null && row.journeys.length === 0,
    'Public monitoring needs journeys; private and local coverage needs an explicit limit',
  );

export const MonitoringPolicyV1 = z
  .object({ schema_version: z.literal(1), projects: z.array(policyProject).min(1).max(60) })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.projects.map((row) => row.catalog_id)).size === policy.projects.length,
    'Duplicate catalog identity',
  );
export type MonitoringPolicy = z.infer<typeof MonitoringPolicyV1>;

const health = z.enum(['healthy', 'degraded', 'failing']);
const freshness = z.enum(['fresh', 'stale', 'missing', 'offline']);
const observation = z.object({
  location: id,
  last_seen_at: z.number().int().nonnegative(),
  interval_seconds: z.number().int().min(60).max(86400),
  freshness,
  health: health.nullable(),
  failure: z.string().max(40).nullable(),
  total_ms: z.number().nonnegative().nullable(),
});

export const MonitoringReportV1 = z.object({
  schema_version: z.literal(1),
  generated_at: z.number().int().nonnegative(),
  policy_updated_at: z.number().int().nonnegative().nullable(),
  projects: z
    .array(
      z.object({
        ...policyFields,
        app_id: z.string().nullable(),
        environment_id: z.string().nullable(),
        state: z.enum([
          'healthy',
          'degraded',
          'failing',
          'stale',
          'missing',
          'offline',
          'unconfigured',
          'local',
          'private',
        ]),
        checks: z
          .array(
            z.object({
              journey: id,
              freshness,
              health: health.nullable(),
              observations: z.array(observation).max(10),
            }),
          )
          .max(10),
      }),
    )
    .max(60),
});
export type MonitoringReport = z.infer<typeof MonitoringReportV1>;
