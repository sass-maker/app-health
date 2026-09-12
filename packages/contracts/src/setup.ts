// V1 app, environment, and ingest-key setup contracts.
// Keys are scoped to one app and one environment. Only a non-reversible
// verifier is stored; the raw key is shown to the operator exactly once.

import { z } from 'zod';
import { MAX_ENVIRONMENT_LENGTH } from './constants.js';

export const EnvironmentName = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(MAX_ENVIRONMENT_LENGTH)
  .regex(/^[a-z][a-z0-9-]*$/, 'lower-case environment slug');

export type EnvironmentName = z.infer<typeof EnvironmentName>;

export const AppV1 = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(128),
  created_at: z.number().int().min(0),
});

export type AppV1 = z.infer<typeof AppV1>;

export const EnvironmentV1 = z.object({
  id: z.string().min(1),
  app_id: z.string().min(1),
  name: EnvironmentName,
  created_at: z.number().int().min(0),
});

export type EnvironmentV1 = z.infer<typeof EnvironmentV1>;

/** Stored key record. `verifier_hash` is the only persisted secret material. */
export const KeyRecordV1 = z.object({
  id: z.string().min(1),
  app_id: z.string().min(1),
  environment_id: z.string().min(1).nullable(),
  verifier_hash: z.string().min(1),
  created_at: z.number().int().min(0),
  revoked_at: z.number().int().min(0).nullable(),
});

export type KeyRecordV1 = z.infer<typeof KeyRecordV1>;

/** One-time key display returned only at creation time. */
export const KeyDisplayV1 = z.object({
  key: z.string().min(1),
  app_id: z.string().min(1),
  environment_id: z.string().min(1).nullable(),
  created_at: z.number().int().min(0),
});

export type KeyDisplayV1 = z.infer<typeof KeyDisplayV1>;

/** Request body accepted by the local app-creation endpoint. */
export const CreateAppRequestV1 = z
  .object({
    name: z.string().trim().min(1).max(128),
    environment: EnvironmentName,
    key_scope: z.enum(['product', 'environment']).optional(),
  })
  .strict();

export type CreateAppRequestV1 = z.infer<typeof CreateAppRequestV1>;

/** Response returned by the local app-creation endpoint. */
export const CreateAppResponseV1 = z.object({
  app: AppV1,
  environment: EnvironmentV1,
  key: KeyDisplayV1,
});

export type CreateAppResponseV1 = z.infer<typeof CreateAppResponseV1>;

export const AppEnvironmentV1 = z.object({
  app: AppV1,
  environments: z.array(EnvironmentV1),
});

export type AppEnvironmentV1 = z.infer<typeof AppEnvironmentV1>;

export const ListAppsResponseV1 = z.object({
  apps: z.array(AppEnvironmentV1),
});

export type ListAppsResponseV1 = z.infer<typeof ListAppsResponseV1>;
