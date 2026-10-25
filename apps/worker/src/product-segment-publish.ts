import type { D1DatabaseLike } from './d1-adapter.js';
import {
  JOB_WHERE,
  jobIdentity,
  type CompactionJob,
  type ProductSegment,
} from './product-segment-model.js';
type PublishedSegment = {
  id: string;
  key: string;
  hash: string;
  bytes: number;
  count: number;
  min: number;
  max: number;
};
/** A single D1 snapshot publishes either all sources or their immutable replacement. */
export async function publishProductSegment(
  db: D1DatabaseLike,
  job: CompactionJob,
  rows: ProductSegment[],
  output: PublishedSegment,
) {
  const now = Date.now(),
    ids = rows.map((row) => row.id),
    slots = ids.map(() => '?').join(',');
  const exists = 'EXISTS(SELECT 1 FROM product_report_segments WHERE id=?)';
  const received = Math.min(...rows.map((row) => row.received_at));
  const statements = [
    db
      .prepare(
        `INSERT INTO product_report_segments(id,workspace_id,app_id,environment_id,channel,event_day,level,format,object_key,object_hash,object_bytes,event_count,min_time,max_time,received_at,cleanup_at)
 SELECT ?,?,?,?,?,?,?,2,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM product_compaction_jobs WHERE ${JOB_WHERE} AND lease_token=? AND lease_until>?) AND (SELECT COUNT(*) FROM product_report_segments WHERE id IN (${slots}) AND active=1 AND received_at>?)=?`,
      )
      .bind(
        output.id,
        ...jobIdentity(job),
        Math.max(...rows.map((row) => row.level)) + 1,
        output.key,
        output.hash,
        output.bytes,
        output.count,
        output.min,
        output.max,
        received,
        received + 31 * 86400000,
        ...jobIdentity(job),
        job.lease_token,
        now,
        ...ids,
        now - 31 * 86400000,
        rows.length,
      ),
    db
      .prepare(
        `UPDATE product_report_segments SET active=0,cleanup_at=? WHERE id IN (${slots}) AND ${exists}`,
      )
      .bind(now + 3600000, ...ids, output.id),
    db
      .prepare(
        `UPDATE product_batches SET object_deleted=1 WHERE reservation IN (SELECT reservation FROM product_report_segments WHERE id IN (${slots})) AND ${exists}`,
      )
      .bind(...ids, output.id),
    ...rows.map((row) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO product_object_gc(object_key,cleanup_at,phase) SELECT ?,?,'fence' WHERE ${exists}`,
        )
        .bind(row.object_key, now + 3600000, output.id),
    ),
    db
      .prepare(
        `UPDATE product_compaction_jobs SET retry_at=0,error_code=NULL WHERE ${JOB_WHERE} AND lease_token=? AND ${exists}`,
      )
      .bind(...jobIdentity(job), job.lease_token, output.id),
    db
      .prepare(`DELETE FROM product_object_gc WHERE object_key=? AND ${exists}`)
      .bind(output.key, output.id),
  ];
  const results = await db.batch(statements);
  return !!results[0].meta.changes;
}
