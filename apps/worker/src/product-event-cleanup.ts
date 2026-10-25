import type { D1DatabaseLike } from './d1-adapter.js';
import type { ProductBucket, ProductReceipt } from './product-event-model.js';
const DAY = 86400000,
  PREFIX = 'product-events/v1/';
function owned(key: string) {
  if (!key.startsWith(PREFIX)) throw new Error('Invalid product cleanup prefix');
}

async function cleanupObjects(db: D1DatabaseLike, bucket: ProductBucket, now: number) {
  const rows = await db
    .prepare(
      'SELECT * FROM product_object_gc WHERE cleanup_at<=? ORDER BY cleanup_at,object_key LIMIT 100',
    )
    .bind(now)
    .all<{ object_key: string; phase: 'fence' | 'delete' }>();
  for (const row of rows.results) {
    owned(row.object_key);
    if (row.phase === 'fence') {
      // An overwrite fences any stale conditional create, whichever R2 write wins first.
      await bucket.put(row.object_key, '{"expired_product_reservation":true}', {
        httpMetadata: { contentType: 'application/json' },
      });
      await db
        .prepare(
          "UPDATE product_object_gc SET phase='delete',cleanup_at=? WHERE object_key=? AND phase='fence'",
        )
        .bind(now + 35 * DAY, row.object_key)
        .run();
    } else {
      await bucket.delete!(row.object_key);
      await db
        .prepare("DELETE FROM product_object_gc WHERE object_key=? AND phase='delete'")
        .bind(row.object_key)
        .run();
    }
  }
  return rows.results.length;
}
/** Each bounded maintenance slice can be continued by Queue; it never scans an R2 prefix. */
export async function cleanupProductArchive(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  now = Date.now(),
) {
  if (!bucket.delete) return { processed: 0, more: false };
  const rows = await db
    .prepare(
      'SELECT * FROM product_batches WHERE cleanup_at<=? ORDER BY cleanup_at,reservation LIMIT 100',
    )
    .bind(now)
    .all<ProductReceipt>();
  for (const row of rows.results) owned(row.object_key);
  const keys = rows.results
    .filter((row) => row.state === 'sealed' && !row.object_deleted && row.accepted_count > 0)
    .map((row) => row.object_key);
  if (keys.length) await bucket.delete(keys);
  if (rows.results.length)
    await db.batch(
      rows.results.flatMap((row) => [
        db
          .prepare(
            "UPDATE product_batches SET object_deleted=1,cleanup_at=expires_at WHERE reservation=? AND state='sealed'",
          )
          .bind(row.reservation),
        db
          .prepare(
            'DELETE FROM product_event_claims WHERE reservation=? AND EXISTS(SELECT 1 FROM product_batches WHERE reservation=? AND expires_at<=?)',
          )
          .bind(row.reservation, row.reservation, now),
        db
          .prepare(
            'DELETE FROM product_batches WHERE reservation=? AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM product_event_claims WHERE reservation=?)',
          )
          .bind(row.reservation, now, row.reservation),
      ]),
    );
  await db.batch([
    db.prepare('DELETE FROM product_event_days WHERE day<?').bind(Math.floor(now / DAY) - 35),
    db.prepare('DELETE FROM product_workspace_days WHERE day<?').bind(Math.floor(now / DAY) - 35),
  ]);
  const gc = await cleanupObjects(db, bucket, now);
  return { processed: rows.results.length + gc, more: rows.results.length === 100 || gc === 100 };
}
