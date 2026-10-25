import type { D1DatabaseLike } from './d1-adapter.js';
import type { ProductSegment } from './product-segment-model.js';
/** Retirement is indexed and leaves a one-hour R2 grace for readers holding the previous snapshot. */
export async function cleanupProductSegments(db: D1DatabaseLike, now: number) {
  const rows = await db
    .prepare(
      'SELECT * FROM product_report_segments WHERE cleanup_at<=? ORDER BY cleanup_at,id LIMIT 100',
    )
    .bind(now)
    .all<ProductSegment>();
  for (const row of rows.results) {
    if (row.active && row.received_at > now - 31 * 86400000) {
      await db
        .prepare('UPDATE product_report_segments SET cleanup_at=? WHERE id=?')
        .bind(row.received_at + 31 * 86400000, row.id)
        .run();
      continue;
    }
    await db.batch([
      db
        .prepare(
          "INSERT OR IGNORE INTO product_object_gc(object_key,cleanup_at,phase) SELECT object_key,?,'fence' FROM product_report_segments WHERE id=?",
        )
        .bind(now + 3600000, row.id),
      db.prepare('DELETE FROM product_report_segments WHERE id=?').bind(row.id),
    ]);
  }
  await db
    .prepare(
      'DELETE FROM product_compaction_jobs WHERE rowid IN (SELECT rowid FROM product_compaction_jobs j WHERE event_day<? AND lease_until<=? AND NOT EXISTS(SELECT 1 FROM product_report_segments s WHERE s.workspace_id=j.workspace_id AND s.app_id=j.app_id AND s.environment_id=j.environment_id AND s.channel=j.channel AND s.event_day=j.event_day) LIMIT 100)',
    )
    .bind(Math.floor(now / 86400000) - 35, now)
    .run();
  return { more: rows.results.length === 100 };
}
