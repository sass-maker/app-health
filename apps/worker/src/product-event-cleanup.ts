import type { D1DatabaseLike } from './d1-adapter.js';
import type { ProductBucket, ProductReceipt } from './product-event-model.js';
const DAY = 86400000;
const PREFIX = 'product-events/v1/';

async function cleanupOrphans(db: D1DatabaseLike, bucket: ProductBucket, now: number) {
  if (!bucket.list || !bucket.delete) return;
  const state = await db
    .prepare('SELECT cursor FROM product_archive_cleanup WHERE id=1')
    .first<{ cursor: string | null }>();
  const page = await bucket.list({
    prefix: PREFIX,
    limit: 100,
    ...(state?.cursor ? { cursor: state.cursor } : {}),
  });
  const old = page.objects.filter((object) => object.uploaded.getTime() < now - 31 * DAY);
  if (old.length) {
    const existing = await db
      .prepare(
        `SELECT object_key FROM product_batches WHERE object_key IN (${old.map(() => '?').join(',')})`,
      )
      .bind(...old.map((object) => object.key))
      .all<{ object_key: string }>();
    const retained = new Set(existing.results.map((row) => row.object_key));
    const orphanKeys = old
      .filter((object) => !retained.has(object.key))
      .map((object) => object.key);
    if (orphanKeys.length) await bucket.delete(orphanKeys);
  }
  await db
    .prepare(
      'INSERT INTO product_archive_cleanup(id,cursor) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor',
    )
    .bind(page.truncated ? page.cursor : null)
    .run();
}

/** Bounded cleanup owns only its prefix; immutable identity receipts outlive raw facts. */
export async function cleanupProductArchive(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  now = Date.now(),
) {
  if (!bucket.delete) return 0;
  const rows = await db
    .prepare(
      `SELECT * FROM product_batches WHERE (state='pending' AND expires_at<=?) OR (state='sealed' AND ((object_deleted=0 AND received_at<?) OR expires_at<=?)) ORDER BY received_at LIMIT 100`,
    )
    .bind(now, now - 31 * DAY, now)
    .all<ProductReceipt>();
  for (const row of rows.results)
    if (!row.object_key.startsWith(PREFIX)) throw new Error('Invalid product cleanup prefix');
  const keys = rows.results
    .filter((row) => !row.object_deleted && (row.accepted_count > 0 || row.state === 'pending'))
    .map((row) => row.object_key);
  if (keys.length) await bucket.delete(keys);
  if (rows.results.length)
    await db.batch(
      rows.results.flatMap((row) => [
        db
          .prepare('UPDATE product_batches SET object_deleted=1 WHERE reservation=?')
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
  await db
    .prepare('DELETE FROM product_event_days WHERE day<?')
    .bind(Math.floor(now / DAY) - 35)
    .run();
  await cleanupOrphans(db, bucket, now);
  return rows.results.length;
}
