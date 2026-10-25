import { cleanupProductArchive } from './product-event-cleanup.js';
import type { ProductEnvironment } from './product-event-model.js';
export type ProductCleanupWake = { type: 'product-archive-cleanup'; schema_version: 1 };
export function isProductCleanupWake(value: unknown): value is ProductCleanupWake {
  if (!value || typeof value !== 'object') return false;
  const wake = value as Record<string, unknown>;
  return (
    Object.keys(wake).sort().join(',') === 'schema_version,type' &&
    wake.type === 'product-archive-cleanup' &&
    wake.schema_version === 1
  );
}
export async function maintainProductArchive(env: ProductEnvironment) {
  const bucket = env.BROWSER_HISTORY;
  if (!env.DB || !bucket?.get || !bucket.delete)
    throw new Error('Product maintenance bindings unavailable');
  const result = await cleanupProductArchive(env.DB, {
    put: bucket.put.bind(bucket),
    get: bucket.get.bind(bucket),
    delete: bucket.delete.bind(bucket),
  });
  if (result.more) {
    if (!env.BROWSER_EVENTS) throw new Error('Product maintenance queue unavailable');
    await env.BROWSER_EVENTS.send(
      { type: 'product-archive-cleanup', schema_version: 1 },
      { delaySeconds: 1 },
    );
  }
  return result;
}
export async function consumeProductMaintenance(
  messages: ReadonlyArray<Pick<Message<ProductCleanupWake>, 'ack' | 'retry'>>,
  env: ProductEnvironment,
) {
  for (const message of messages) {
    try {
      await maintainProductArchive(env);
      message.ack();
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}
