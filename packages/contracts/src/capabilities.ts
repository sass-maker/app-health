import { z } from 'zod';
import { EnvironmentName, EnvironmentV1, KeyDisplayV1 } from './setup.js';

export const CapabilityId = z.enum(['analytics', 'endpoints', 'logs']);
export type CapabilityId = z.infer<typeof CapabilityId>;
export const CAPABILITY_IDS = CapabilityId.options;
export const CapabilityState = z.object({
  id: CapabilityId,
  enabled: z.boolean(),
  first_received_at: z.number().int().nonnegative().nullable(),
  last_received_at: z.number().int().nonnegative().nullable(),
});
export type CapabilityState = z.infer<typeof CapabilityState>;
export const CapabilitySelection = z.object({ enabled: z.array(CapabilityId).max(3) }).strict();
export const EnvironmentCapabilities = z.object({
  app_id: z.string().min(1),
  environment_id: z.string().min(1),
  capabilities: z.array(CapabilityState),
  private_key: z
    .object({
      id: z.string(),
      environment_id: z.string().nullable(),
      created_at: z.number(),
      revoked_at: z.number().nullable(),
    })
    .nullable(),
});
export type EnvironmentCapabilities = z.infer<typeof EnvironmentCapabilities>;
export const CapabilityLedgerV1 = z
  .object({
    schema_version: z.literal(1),
    app_id: z.string().min(1),
    environment_id: z.string().min(1),
    collection: z.array(CapabilityState).length(3),
    features: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            status: z.enum(['available', 'partial', 'planned', 'deferred']),
            explanation: z.string().min(1).max(400),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type CapabilityLedger = z.infer<typeof CapabilityLedgerV1>;
export const CreateEnvironmentRequest = z.object({ name: EnvironmentName }).strict();
export const EnvironmentKeyResponse = z.object({ environment: EnvironmentV1, key: KeyDisplayV1 });
export type EnvironmentKeyResponse = z.infer<typeof EnvironmentKeyResponse>;
