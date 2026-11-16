import { z } from 'zod';

export const CatalogPublisherError = z.enum([
  'invalid_catalog',
  'source_unavailable',
  'service_unavailable',
  'review_required',
  'conflict',
]);
const timestamp = z.number().int().nonnegative();
export const CatalogPublisherV1 = z.object({
  id: z.string().uuid(),
  label: z.string().min(1).max(80),
  approved_at: timestamp,
  revoked_at: timestamp.nullable(),
  last_attempt_at: timestamp.nullable(),
  last_success_at: timestamp.nullable(),
  last_error: CatalogPublisherError.nullable(),
});
export type CatalogPublisher = z.infer<typeof CatalogPublisherV1>;
export const CatalogPublishersV1 = z.object({ publishers: z.array(CatalogPublisherV1).max(10) });
export const CatalogPublisherApprovalV1 = z
  .object({
    code: z.string().regex(/^[A-F0-9]{12}$/),
    allow_automatic_updates: z.literal(true),
    preserve_outside_catalog_app_ids: z.array(z.string().min(1).max(100)).max(60),
  })
  .strict();
export const CatalogPublisherEnrollmentV1 = z
  .object({ label: z.string().trim().min(1).max(80) })
  .strict();
export const CatalogPublisherEnrollmentResponseV1 = z
  .object({
    publisher_id: z.string().uuid(),
    code: z.string().regex(/^[A-F0-9]{12}$/),
    secret: z.string().regex(/^ahcp_[a-f0-9]{64}$/),
    expires_at: timestamp,
  })
  .strict();
export const CatalogPublisherReportV1 = z
  .object({ error: CatalogPublisherError.nullable() })
  .strict();
export const CatalogPublisherIdentityV1 = z.object({ publisher_id: z.string().uuid() }).strict();
export const CatalogPublisherPairingV1 = z.object({ label: z.string().min(1).max(80) }).strict();
export const CatalogPublisherStatusV1 = z
  .object({
    state: z.enum(['pending', 'approved']),
    publisher_id: z.string().uuid(),
    label: z.string().min(1).max(80),
    expires_at: timestamp,
    projection_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    project_count: z.number().int().nonnegative().nullable(),
  })
  .strict();
