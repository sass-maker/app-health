import { z } from 'zod';
import { LogEventV1 } from './log.js';

/** Public native writes are explicit claims, never server endpoint measurements. */
export const NativeEventV1 = z
  .object({
    event_id: z.string().uuid(),
    timestamp: z.number().int().nonnegative(),
    name: z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/),
    screen: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .optional(),
  })
  .strict();
export const NativeBatchV1 = z
  .object({
    schema_version: z.literal(1),
    public_key: z.string().regex(/^ahk_native_[a-f0-9]{64}$/),
    batch_id: z.string().uuid(),
    session_id: z.string().uuid(),
    active: z.boolean(),
    events: z.array(NativeEventV1).max(25),
    logs: z.array(LogEventV1).max(25),
  })
  .strict()
  .refine((batch) => batch.events.length + batch.logs.length <= 25);
export type NativeBatchV1 = z.infer<typeof NativeBatchV1>;
export const NativeKey = z.object({
  id: z.string().uuid(),
  workspace_id: z.string(),
  app_id: z.string(),
  environment_id: z.string(),
  created_at: z.number().int().nonnegative(),
  revoked_at: z.number().int().nonnegative().nullable(),
});
export type NativeKey = z.infer<typeof NativeKey>;
