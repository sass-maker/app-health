import { z } from 'zod';

const CatalogProject = z
  .object({
    catalog_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
    name: z.string().trim().min(1).max(100),
    repository: z
      .string()
      .regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .nullable()
      .default(null),
    hostname: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
      .nullable()
      .default(null),
    lifecycle: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    existing_app_id: z.string().min(1).max(100).optional(),
  })
  .strict();

export const CatalogImportRequestV1 = z
  .object({
    schema_version: z.literal(1),
    projects: z.array(CatalogProject).min(1).max(10),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.projects.map((project) => project.catalog_id)).size === input.projects.length,
    {
      message: 'catalog identities must be unique within one import',
    },
  );
export type CatalogImportRequest = z.infer<typeof CatalogImportRequestV1>;
