import { cleanupProductSegments } from './product-segment-cleanup.js';
import type { D1PreparedStatement, D1DatabaseLike } from './d1-adapter.js';
import type { ProductBucket, ProductReceipt } from './product-event-model.js';
const DAY = 86400000,
  PREFIX = 'product-events/v1/';
function owned(key: string) {
  if (!key.startsWith(PREFIX)) throw new Error('Invalid product cleanup prefix');
}

type ObjectGarbage = { object_key: string; phase: 'fence' | 'delete' };
async function cleanupObjects(db: D1DatabaseLike, bucket: ProductBucket, now: number) {
  const rows = await db
    .prepare(
      'SELECT * FROM product_object_gc WHERE cleanup_at<=? ORDER BY cleanup_at,object_key LIMIT 100',
    )
    .bind(now)
    .all<ObjectGarbage>();
  const deadline = performance.now() + 18000;
  let processed = 0;
  for (const row of rows.results) {
    if (performance.now() > deadline) break;
    owned(row.object_key);
    processed++;
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
  return { processed, more: processed !== rows.results.length || rows.results.length === 100 };
}
function effectiveCleanup(row: ProductReceipt) {
  if (row.state === 'pending') return row.expires_at;
  return row.object_deleted
    ? Math.max(row.expires_at, row.received_at + 35 * DAY)
    : row.received_at + 31 * DAY;
}
function retireRawReferences(
  db: D1DatabaseLike,
  row: ProductReceipt,
  now: number,
): D1PreparedStatement[] {
  if (
    row.state !== 'sealed' ||
    row.object_deleted ||
    row.accepted_count === 0 ||
    row.received_at > now - 31 * DAY
  )
    return [];
  const eligible =
    "SELECT 1 FROM product_batches WHERE reservation=? AND state='sealed' AND object_deleted=0 AND received_at<=?";
  return [
    db
      .prepare(
        `UPDATE product_report_segments SET active=0,cleanup_at=? WHERE object_key=? AND EXISTS(${eligible})`,
      )
      .bind(now + 3600000, row.object_key, row.reservation, now - 31 * DAY),
    db
      .prepare(
        `INSERT INTO product_object_gc(object_key,cleanup_at,phase) SELECT object_key,?,'fence' FROM product_batches WHERE reservation=? AND state='sealed' AND object_deleted=0 AND accepted_count>0 AND received_at<=? ON CONFLICT(object_key) DO UPDATE SET cleanup_at=MAX(product_object_gc.cleanup_at,excluded.cleanup_at) WHERE product_object_gc.phase='fence'`,
      )
      .bind(now + 3600000, row.reservation, now - 31 * DAY),
  ];
}
async function retireReceipts(db: D1DatabaseLike, rows: ProductReceipt[], now: number) {
  if (rows.length)
    await db.batch(
      rows.flatMap((row) => [
        ...retireRawReferences(db, row, now),
        db
          .prepare(
            "UPDATE product_batches SET object_deleted=1,cleanup_at=MAX(expires_at,received_at+?) WHERE reservation=? AND state='sealed' AND received_at<=?",
          )
          .bind(35 * DAY, row.reservation, now - 31 * DAY),
        db
          .prepare(
            `DELETE FROM product_event_claims WHERE reservation=? AND EXISTS(SELECT 1 FROM product_batches WHERE reservation=? AND expires_at<=? AND (state='pending' OR received_at<=?))`,
          )
          .bind(row.reservation, row.reservation, now, now - 35 * DAY),
        db
          .prepare(
            `DELETE FROM product_batches WHERE reservation=? AND expires_at<=? AND (state='pending' OR received_at<=?) AND NOT EXISTS(SELECT 1 FROM product_event_claims WHERE reservation=?)`,
          )
          .bind(row.reservation, now, now - 35 * DAY, row.reservation),
      ]),
    );
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
  const due = rows.results.filter((row) => {
    owned(row.object_key);
    return effectiveCleanup(row) <= now;
  });
  const stale = rows.results.filter((row) => effectiveCleanup(row) > now);
  if (stale.length)
    await db.batch(
      stale.map((row) =>
        db
          .prepare('UPDATE product_batches SET cleanup_at=? WHERE reservation=?')
          .bind(effectiveCleanup(row), row.reservation),
      ),
    );
  await retireReceipts(db, due, now);
  await db.batch([
    db.prepare('DELETE FROM product_event_days WHERE day<?').bind(Math.floor(now / DAY) - 35),
    db.prepare('DELETE FROM product_workspace_days WHERE day<?').bind(Math.floor(now / DAY) - 35),
  ]);
  const segments = await cleanupProductSegments(db, now);
  const gc = await cleanupObjects(db, bucket, now);
  return {
    processed: due.length + gc.processed,
    more: rows.results.length === 100 || gc.more || segments.more,
  };
}
