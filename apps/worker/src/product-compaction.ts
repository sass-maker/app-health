import type { D1DatabaseLike } from './d1-adapter.js';
import {
  ProductError,
  canonicalProductJson,
  productDigest,
  type ProductBucket,
  type ProductScope,
} from './product-event-model.js';
import { readProductObject } from './product-event-archive.js';
import {
  JOB_WHERE,
  jobIdentity,
  type CompactionJob,
  type ProductSegment,
} from './product-segment-model.js';
import { publishProductSegment } from './product-segment-publish.js';
const DAY = 86400000,
  MAX_BYTES = 1024 * 1024;
const READY = '(dirty=1 OR (closed=0 AND event_day<?)) AND retry_at<=? AND lease_until<=?';
async function moreReady(db: D1DatabaseLike) {
  const now = Date.now();
  return !!(await db
    .prepare(`SELECT 1 FROM product_compaction_jobs WHERE ${READY} LIMIT 1`)
    .bind(Math.floor(now / DAY), now, now)
    .first());
}

async function claim(db: D1DatabaseLike, scope?: ProductScope) {
  const now = Date.now(),
    token = crypto.randomUUID();
  const filter = scope ? ' AND workspace_id=? AND app_id=? AND environment_id=? AND channel=?' : '';
  const params = scope ? [scope.workspace, scope.app_id, scope.environment_id, scope.channel] : [];
  return db
    .prepare(
      `UPDATE product_compaction_jobs SET lease_token=?,lease_until=? WHERE rowid IN (SELECT rowid FROM product_compaction_jobs WHERE ${READY} ${filter} ORDER BY event_day LIMIT 1) RETURNING *`,
    )
    .bind(token, now + 60000, Math.floor(now / DAY), now, now, ...params)
    .first<CompactionJob>();
}
async function candidates(db: D1DatabaseLike, job: CompactionJob) {
  const old = job.event_day < Math.floor(Date.now() / DAY);
  let level: number | undefined;
  if (!old) {
    const row = await db
      .prepare(
        `SELECT level FROM product_report_segments WHERE ${JOB_WHERE} AND active=1 AND received_at>? GROUP BY level HAVING COUNT(*)>=32 ORDER BY level LIMIT 1`,
      )
      .bind(...jobIdentity(job), Date.now() - 31 * DAY)
      .first<{ level: number }>();
    if (!row) return [];
    level = row.level;
  }
  const rows = await db
    .prepare(
      `SELECT * FROM product_report_segments WHERE ${JOB_WHERE} AND active=1 AND received_at>? ${level === undefined ? '' : ' AND level=?'} ORDER BY received_at,object_bytes,id LIMIT 32`,
    )
    .bind(...jobIdentity(job), Date.now() - 31 * DAY, ...(level === undefined ? [] : [level]))
    .all<ProductSegment>();
  let bytes = 8192,
    count = 0,
    firstReceived = Infinity,
    lastTime = -Infinity;
  const selected: ProductSegment[] = [];
  for (const row of rows.results) {
    const first = Math.min(row.received_at, firstReceived);
    const last = Math.max(row.max_time, lastTime);
    // The earliest receipt anchors 31-day expiry; every event still needs 30-day coverage.
    if (last > first + DAY) continue;
    if (bytes + row.object_bytes > MAX_BYTES || count + row.event_count > 5000) continue;
    firstReceived = first;
    lastTime = last;
    bytes += row.object_bytes;
    count += row.event_count;
    selected.push(row);
  }
  return selected.length >= 2 ? selected : [];
}
async function merge(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  job: CompactionJob,
  rows: ProductSegment[],
) {
  const facts = [] as Awaited<ReturnType<typeof readProductObject>>,
    budget = { total: 0, limit: MAX_BYTES },
    deadline = performance.now() + 18000;
  for (const row of rows) {
    if (performance.now() > deadline)
      throw new ProductError('Product compaction time limit exceeded');
    facts.push(...(await readProductObject(bucket, row, budget)));
    if (facts.length > 5000) throw new ProductError('Product compaction event limit exceeded');
  }
  const ids = new Set(facts.map((fact) => fact.event.event_id));
  if (ids.size !== facts.length) throw new ProductError('Product segment identity overlap');
  const id = crypto.randomUUID(),
    scope: ProductScope = {
      workspace: job.workspace_id,
      app_id: job.app_id,
      environment_id: job.environment_id,
      channel: job.channel,
    };
  const envelope = {
    schema_version: 2,
    scope,
    segment_id: id,
    events: facts.map((fact) => fact.event).sort((a, b) => a.event_id.localeCompare(b.event_id)),
  };
  const body = canonicalProductJson(envelope),
    bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > MAX_BYTES)
    throw new ProductError('Product compacted object exceeds byte limit');
  const hash = await productDigest(envelope),
    key = `product-events/v1/segments/${await productDigest(scope)}/${id}.json`;
  // The candidate is tracked before R2; a crash or failed publication leaves indexed garbage work.
  await db
    .prepare("INSERT INTO product_object_gc(object_key,cleanup_at,phase) VALUES(?,?,'fence')")
    .bind(key, Date.now() + 10 * 60000)
    .run();
  const created = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256: hash },
  });
  if (!created) throw new ProductError('Compaction object identity conflict');
  return publishProductSegment(db, job, rows, {
    id,
    key,
    hash,
    bytes: bytes.byteLength,
    count: facts.length,
    min: Math.min(...facts.map((f) => f.event.occurred_at)),
    max: Math.max(...facts.map((f) => f.event.occurred_at)),
  });
}
/** One lease, <=32 verified objects/1MiB/5k facts. Publication never mutates accepted facts. */
export async function compactProductArchive(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  scope?: ProductScope,
) {
  const job = await claim(db, scope);
  if (!job) return { published: false, more: false };
  try {
    const rows = await candidates(db, job);
    if (rows.length) return { published: await merge(db, bucket, job, rows), more: true };
    await db
      .prepare(
        `UPDATE product_compaction_jobs SET dirty=0,closed=?,retry_at=0,error_code=NULL WHERE ${JOB_WHERE} AND lease_token=? AND epoch=?`,
      )
      .bind(
        job.event_day < Math.floor(Date.now() / DAY) ? 1 : 0,
        ...jobIdentity(job),
        job.lease_token,
        job.epoch,
      )
      .run();
    return { published: false, more: await moreReady(db) };
  } catch {
    // A poisoned scope must not monopolize the global maintenance chain. Never retain parser text.
    console.warn(JSON.stringify({ event: 'product_compaction_failed' }));
    await db
      .prepare(
        `UPDATE product_compaction_jobs SET dirty=1,retry_at=?,error_code='compaction_failed' WHERE ${JOB_WHERE} AND lease_token=?`,
      )
      .bind(Date.now() + 15 * 60000, ...jobIdentity(job), job.lease_token)
      .run();
    return { published: false, more: await moreReady(db), failed: true };
  } finally {
    await db
      .prepare(
        `UPDATE product_compaction_jobs SET lease_token=NULL,lease_until=0 WHERE ${JOB_WHERE} AND lease_token=?`,
      )
      .bind(...jobIdentity(job), job.lease_token)
      .run();
  }
}
