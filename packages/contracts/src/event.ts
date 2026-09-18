// V1 ingest event and batch contracts with runtime validation.
// SDKs send batches of endpoint performance summaries; ingest validates and
// aggregates them. No headers, cookies, query values, route parameter values,
// bodies, identity, logs, stacks, or spans are ever accepted. Response
// payload size is a bounded byte count, never response content.

import { z } from 'zod';
import {
  MAX_BATCH_EVENTS,
  MAX_DURATION_MS,
  MAX_METHOD_LENGTH,
  MAX_RELEASE_LENGTH,
  MAX_RESPONSE_BYTES,
  MAX_ROUTE_LENGTH,
  MAX_STATUS_CODE,
  MIN_STATUS_CODE,
  RUNTIMES,
  SCHEMA_VERSION,
} from './constants.js';
import { EnvironmentName } from './setup.js';

const uuidV4 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'uuid v4');

const method = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(MAX_METHOD_LENGTH)
  .regex(/^[A-Z]+$/, 'uppercase HTTP method');

const route = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ROUTE_LENGTH)
  .refine((v) => v.startsWith('/'), 'route must start with /');

const statusCode = z.number().int().min(MIN_STATUS_CODE).max(MAX_STATUS_CODE);

const durationMs = z.number().int().min(0).max(MAX_DURATION_MS);

const responseBytes = z.number().int().min(0).max(MAX_RESPONSE_BYTES).optional();

const release = z.string().trim().min(1).max(MAX_RELEASE_LENGTH).optional();

const timestamp = z.number().int().min(0);

/** A single endpoint performance summary. */
export const EventV1 = z
  .object({
    event_id: uuidV4,
    timestamp,
    method,
    route,
    status_code: statusCode,
    duration_ms: durationMs,
    response_bytes: responseBytes,
    release,
  })
  .strict();

export type EventV1 = z.infer<typeof EventV1>;

/** SDK runtime reported for installation verification. */
export const RuntimeField = z.enum(RUNTIMES);
export type RuntimeField = z.infer<typeof RuntimeField>;

/** V1 ingest batch. */
export const EventBatchV1 = z
  .object({
    // Optional only for rollout compatibility with already-released SDKs.
    // Current SDKs always send it; ingest derives a stable ID for legacy batches.
    batch_id: uuidV4.optional(),
    schema_version: z.literal(SCHEMA_VERSION),
    runtime: RuntimeField,
    environment: EnvironmentName.optional(),
    release: release,
    events: z.array(EventV1).min(1).max(MAX_BATCH_EVENTS),
  })
  .strict();

export type EventBatchV1 = z.infer<typeof EventBatchV1>;

/** Result of validating a batch. */
export type BatchValidationOk = {
  ok: true;
  batch: EventBatchV1;
};

export type BatchValidationError = {
  ok: false;
  errors: { path: string; message: string }[];
};

export type BatchValidationResult = BatchValidationOk | BatchValidationError;

/** Validate an unknown payload as a v1 batch, returning structured errors. */
export function validateBatch(input: unknown): BatchValidationResult {
  const parsed = EventBatchV1.safeParse(input);
  if (parsed.success) {
    return { ok: true, batch: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
