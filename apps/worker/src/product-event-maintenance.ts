import { cleanupProductArchive } from './product-event-cleanup.js';
import type { ProductEnvironment } from './product-event-model.js';
export type ProductCleanupWake = {
  type: 'product-archive-cleanup';
  schema_version: 1 | 2;
  wake_token?: string;
};
export function isProductCleanupWake(value: unknown): value is ProductCleanupWake {
  if (!value || typeof value !== 'object') return false;
  const wake = value as Record<string, unknown>;
  const keys = wake.schema_version === 2 ? 'schema_version,type,wake_token' : 'schema_version,type';
  return (
    Object.keys(wake).sort().join(',') === keys &&
    wake.type === 'product-archive-cleanup' &&
    (wake.schema_version === 1 ||
      (wake.schema_version === 2 &&
        typeof wake.wake_token === 'string' &&
        /^[a-f0-9-]{36}$/.test(wake.wake_token)))
  );
}
/** Cron and duplicate deliveries merge into one durable maintenance wake. */
export async function maintainProductArchive(
  env: ProductEnvironment,
  previous: string | null = null,
) {
  if (!env.DB || !env.BROWSER_EVENTS) throw new Error('Product maintenance bindings unavailable');
  const token = crypto.randomUUID(),
    now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE product_archive_maintenance SET wake_token=?,wake_until=? WHERE id=1 AND (wake_token=? OR wake_token IS NULL OR wake_until<=?)`,
  )
    .bind(token, now + 60000, previous, now)
    .run();
  if (!result.meta.changes) return;
  try {
    await env.BROWSER_EVENTS.send(
      { type: 'product-archive-cleanup', schema_version: 2, wake_token: token },
      { delaySeconds: 1 },
    );
  } catch (error) {
    await env.DB.prepare(
      'UPDATE product_archive_maintenance SET wake_token=?,wake_until=0 WHERE id=1 AND wake_token=?',
    )
      .bind(previous?.replace(/^processing:/, '') ?? null, token)
      .run();
    throw error;
  }
}
async function consumeOne(wake: ProductCleanupWake, env: ProductEnvironment) {
  if (wake.schema_version === 1) {
    await maintainProductArchive(env);
    return false;
  }
  const bucket = env.BROWSER_HISTORY;
  if (!env.DB || !bucket?.get || !bucket.delete)
    throw new Error('Product maintenance bindings unavailable');
  const processing = 'processing:' + wake.wake_token;
  const claimed = await env.DB.prepare(
    'UPDATE product_archive_maintenance SET wake_token=?,wake_until=? WHERE id=1 AND wake_token=?',
  )
    .bind(processing, Date.now() + 60000, wake.wake_token)
    .run();
  if (!claimed.meta.changes) return false;
  const result = await cleanupProductArchive(env.DB, {
    put: bucket.put.bind(bucket),
    get: bucket.get.bind(bucket),
    delete: bucket.delete.bind(bucket),
  });
  if (result.more) await maintainProductArchive(env, processing);
  else
    await env.DB.prepare(
      'UPDATE product_archive_maintenance SET wake_token=NULL,wake_until=0 WHERE id=1 AND wake_token=?',
    )
      .bind(processing)
      .run();
  return true;
}
export async function consumeProductMaintenance(
  messages: ReadonlyArray<Pick<Message<ProductCleanupWake>, 'body' | 'ack' | 'retry'>>,
  env: ProductEnvironment,
) {
  let ran = false;
  for (const message of messages) {
    try {
      // A second current token must be redelivered; stale duplicates need no work.
      if (ran && message.body.schema_version === 2) {
        const current = await env.DB?.prepare(
          'SELECT wake_token FROM product_archive_maintenance WHERE id=1 AND wake_token=?',
        )
          .bind(message.body.wake_token)
          .first();
        if (current) {
          message.retry({ delaySeconds: 1 });
          continue;
        }
      }
      ran = (await consumeOne(message.body, env)) || ran;
      message.ack();
    } catch {
      if (env.DB && message.body.wake_token)
        await env.DB.prepare(
          'UPDATE product_archive_maintenance SET wake_token=?,wake_until=0 WHERE id=1 AND wake_token=?',
        )
          .bind(message.body.wake_token, 'processing:' + message.body.wake_token)
          .run();
      message.retry({ delaySeconds: 30 });
    }
  }
}
