import { z } from 'zod';
import { MonitoringPolicyV1 } from './monitoring.js';

export const MAX_CATALOG_OUTSIDE_APPS = 60;
export const MAX_CATALOG_LINKED_IDENTITIES = 1000;

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);
const facet = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/);
export const CatalogMetadataV1 = z.object({
  source: z.literal('saas-maker'),
  catalog_id: slug,
  kind: facet,
  future_form: facet,
  auth_model: facet,
});
export type CatalogMetadata = z.infer<typeof CatalogMetadataV1>;
export const CatalogSyncStatusV1 = z
  .object({
    source: z.literal('saas-maker').nullable(),
    projection_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    updated_at: z.number().int().nonnegative().nullable(),
    project_count: z.number().int().nonnegative().nullable(),
    mapped_catalog_ids: z.array(slug).max(MAX_CATALOG_LINKED_IDENTITIES),
    unlinked_apps: z
      .array(
        z.object({ app_id: z.string().min(1).max(100), name: z.string().min(1).max(128) }).strict(),
      )
      .max(MAX_CATALOG_OUTSIDE_APPS),
  })
  .strict();
export type CatalogSyncStatus = z.infer<typeof CatalogSyncStatusV1>;

const applicability = z.enum(['applicable', 'not_applicable', 'unknown']);
const project = z
  .object({
    catalog_id: slug,
    name: z.string().trim().min(1).max(100),
    kind: facet,
    future_form: facet,
    auth_model: facet,
    repository: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable(),
    hostname: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
      .nullable(),
    browser_visitors: applicability.optional(),
    native_sessions: applicability.optional(),
    server_requests: applicability.optional(),
  })
  .strict();
export const CatalogSyncRequestV1 = z
  .object({
    schema_version: z.literal(1),
    source: z.literal('saas-maker'),
    source_catalog_schema_version: z.literal(2),
    expected_previous_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    preserve_outside_catalog_app_ids: z
      .array(z.string().min(1).max(100))
      .max(MAX_CATALOG_OUTSIDE_APPS)
      .default([]),
    projects: z.array(project).min(1).max(60),
    monitoring: MonitoringPolicyV1,
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.projects.map((row) => row.catalog_id);
    if (
      new Set(input.preserve_outside_catalog_app_ids).size !==
        input.preserve_outside_catalog_app_ids.length ||
      new Set(ids).size !== ids.length ||
      input.monitoring.projects.length !== ids.length ||
      input.monitoring.projects.some(
        (row) =>
          !ids.includes(row.catalog_id) ||
          row.name !== input.projects.find((entry) => entry.catalog_id === row.catalog_id)?.name,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'Catalog and monitoring must have the same unique projects and names',
      });
  });
export type CatalogSyncRequest = z.infer<typeof CatalogSyncRequestV1>;

const canonical = z.object({
  catalogSchemaVersion: z.literal(2),
  projects: z
    .array(
      z.object({
        id: slug,
        name: z.string(),
        lifecycle: z.object({ portfolioStatus: z.enum(['active', 'archived']) }),
        classification: z.object({ kind: facet, futureForm: facet }).optional(),
        deployment: z
          .object({ authModel: facet, domains: z.array(z.string()).optional() })
          .optional(),
        repositories: z.object({ url: z.string().optional() }).optional(),
        systems: z
          .object({
            probe: z
              .object({
                scope: z.enum(['local', 'private']).optional(),
                absent: z.string().optional(),
                journeys: z.array(z.object({ journey: slug })).optional(),
              })
              .optional(),
            appHealth: z
              .object({
                browserVisitors: z
                  .union([z.string(), z.object({ applicability: z.string().optional() })])
                  .optional(),
                nativeSessions: z
                  .union([z.string(), z.object({ applicability: z.string().optional() })])
                  .optional(),
                serverRequests: z
                  .union([z.string(), z.object({ applicability: z.string().optional() })])
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(1000),
});

/** Raw catalog data stays in the importing browser. Only this allowlist crosses the API. */
export function projectCanonicalCatalog(
  value: unknown,
  previousHash: string | null,
): CatalogSyncRequest {
  const parsed = canonical.parse(value);
  if (new Set(parsed.projects.map((row) => row.id)).size !== parsed.projects.length)
    throw new Error('Duplicate catalog identity');
  const active = parsed.projects.filter((row) => row.lifecycle.portfolioStatus === 'active');
  const projects = active.map((row) => {
    if (!row.classification || !row.deployment)
      throw new Error(`Missing classification for ${row.id}`);
    const metrics = row.systems?.appHealth;
    const metric = (source: string | { applicability?: string } | undefined) => {
      const value = (typeof source === 'string' ? source : source?.applicability)?.replaceAll(
        '-',
        '_',
      );
      return applicability.safeParse(value).success
        ? (value as z.infer<typeof applicability>)
        : undefined;
    };
    const repository = project.shape.repository.safeParse(row.repositories?.url ?? null);
    const hostname = project.shape.hostname.safeParse(row.deployment.domains?.[0] ?? null);
    return {
      catalog_id: row.id,
      name: row.name,
      kind: row.classification.kind,
      future_form: row.classification.futureForm,
      auth_model: row.deployment.authModel,
      repository: repository.success ? repository.data : null,
      hostname: hostname.success ? hostname.data : null,
      browser_visitors: metric(metrics?.browserVisitors),
      native_sessions: metric(metrics?.nativeSessions),
      server_requests: metric(metrics?.serverRequests),
    };
  });
  const monitoring = {
    schema_version: 1,
    projects: active.map((row) => {
      const probe = row.systems?.probe;
      if (!probe || (probe.journeys?.length && (probe.scope || probe.absent)))
        throw new Error(`Ambiguous or missing monitoring declaration for ${row.id}`);
      if (probe.scope && probe.absent && !probe.journeys?.length)
        return {
          catalog_id: row.id,
          name: row.name,
          scope: probe.scope,
          reason:
            probe.scope === 'local'
              ? 'Local project; public monitoring does not apply.'
              : 'Private project; public monitoring does not apply.',
          journeys: [],
        };
      if (!probe.journeys?.length || probe.scope || probe.absent)
        throw new Error(`Missing explicit monitoring coverage for ${row.id}`);
      return {
        catalog_id: row.id,
        name: row.name,
        scope: 'public',
        reason: null,
        journeys: probe.journeys.map((journey) => journey.journey),
      };
    }),
  };
  return CatalogSyncRequestV1.parse({
    schema_version: 1,
    source: 'saas-maker',
    source_catalog_schema_version: 2,
    expected_previous_hash: previousHash,
    projects,
    monitoring,
  });
}
