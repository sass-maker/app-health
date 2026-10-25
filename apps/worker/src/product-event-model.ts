import type { ProductCleanupWake } from './product-event-maintenance.js';
import { ProductEventV1 } from '@app-health/contracts';
import { hashKey } from './crypto.js';
import { browserSessionScope } from './browser-analytics.js';
import type { D1DatabaseLike } from './d1-adapter.js';
export type ProductScope = {
  workspace: string;
  app_id: string;
  environment_id: string;
  channel: ProductEventV1['channel'];
};
export type ProductBucket = Pick<R2Bucket, 'put' | 'get'> &
  Partial<Pick<R2Bucket, 'delete' | 'list'>>;
export type ProductEnvironment = {
  BROWSER_EVENTS?: {
    send(wake: ProductCleanupWake, options?: { delaySeconds: number }): Promise<unknown>;
  };
  DB?: D1DatabaseLike;
  BROWSER_HISTORY?: Pick<R2Bucket, 'put'> & Partial<Pick<R2Bucket, 'get' | 'delete' | 'list'>>;
  APP_HEALTH_INGEST_HOST?: string;
};
export type ProductReceipt = {
  workspace_id: string;
  app_id: string;
  environment_id: string;
  channel: ProductEventV1['channel'];
  batch_id: string;
  digest: string;
  reservation: string;
  state: 'pending' | 'sealed';
  object_key: string;
  cleanup_at: number;
  object_deleted: number;
  object_hash: string | null;
  object_bytes: number | null;
  input_count: number;
  accepted_count: number;
  min_time: number;
  max_time: number;
  received_at: number;
  expires_at: number;
};
export type ProductFact = { scope: ProductScope; event: ProductEventV1 };
export class ProductError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}
export function canonicalProductJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalProductJson).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonicalProductJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export async function normalizedProductEvents(scope: ProductScope, events: ProductEventV1[]) {
  const normalized = await Promise.all(
    events.map(async (input) =>
      ProductEventV1.parse({
        ...input,
        channel: scope.channel,
        ...(input.visitor_id
          ? {
              visitor_id: await browserSessionScope(
                scope.app_id,
                scope.environment_id,
                `visitor:${input.visitor_id}`,
              ),
            }
          : {}),
        ...(input.session_id
          ? {
              session_id: await browserSessionScope(
                scope.app_id,
                scope.environment_id,
                input.session_id,
              ),
            }
          : {}),
      }),
    ),
  );
  const unique = new Map<string, ProductEventV1>();
  for (const event of normalized) {
    const saved = unique.get(event.event_id);
    if (saved && canonicalProductJson(saved) !== canonicalProductJson(event))
      throw new ProductError('Product event identity conflict', 409);
    unique.set(event.event_id, event);
  }
  return [...unique.values()].sort((a, b) => a.event_id.localeCompare(b.event_id));
}
export async function productDigest(value: unknown) {
  return hashKey(canonicalProductJson(value));
}
export function productFailure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/identity conflict/.test(message))
    return new ProductError(
      'Batch or event identity conflicts with previously submitted facts',
      409,
    );
  if (/original pending/.test(message))
    return new ProductError(
      'An identical event is awaiting durable acceptance; retry the original batch',
      503,
    );
  if (/retained or pending capacity|retained capacity/.test(message))
    return new ProductError(
      'Product event retained identity or pending-upload capacity reached; retry after maintenance completes or reduce workspace traffic',
      429,
    );
  if (/workspace daily capacity/.test(message))
    return new ProductError(
      'Workspace daily capacity reached (25,000 events or 40 MiB); retry after the UTC day resets',
      429,
    );
  if (/CHECK constraint failed: events/.test(message))
    return new ProductError(
      'Project daily capacity reached (5,000 events or 8 MiB); retry after the UTC day resets',
      429,
    );
  return error instanceof ProductError
    ? error
    : new ProductError('Product event archive unavailable; no durable acceptance is claimed');
}
