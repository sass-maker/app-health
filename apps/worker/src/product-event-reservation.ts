import type { ProductEventV1 } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import {
  canonicalProductJson,
  productDigest,
  type ProductScope,
  type ProductReceipt,
  ProductError,
} from './product-event-model.js';
const identity = (scope: ProductScope, id: string) => [
  scope.workspace,
  scope.app_id,
  scope.environment_id,
  scope.channel,
  id,
];
export async function reserveProductBatch(
  db: D1DatabaseLike,
  scope: ProductScope,
  batch: string,
  events: ProductEventV1[],
) {
  const now = Date.now(),
    reservation = crypto.randomUUID();
  const digest = await productDigest(events);
  const scopeHash = await productDigest([
    scope.workspace,
    scope.app_id,
    scope.environment_id,
    scope.channel,
  ]);
  const key = `product-events/v1/${scopeHash}/${batch}/${reservation}.json`;
  const expired = `SELECT reservation FROM product_batches WHERE workspace_id=? AND app_id=? AND state='pending' AND expires_at<=?`;
  const statements = [
    db
      .prepare(`DELETE FROM product_event_claims WHERE reservation IN (${expired})`)
      .bind(scope.workspace, scope.app_id, now),
    db
      .prepare(
        `DELETE FROM product_batches WHERE workspace_id=? AND app_id=? AND state='pending' AND expires_at<=?`,
      )
      .bind(scope.workspace, scope.app_id, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO product_batches(workspace_id,app_id,environment_id,channel,batch_id,digest,reservation,state,object_key,input_count,input_bytes,min_time,max_time,received_at,expires_at,cleanup_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)`,
      )
      .bind(
        ...identity(scope, batch),
        digest,
        reservation,
        key,
        events.length,
        new TextEncoder().encode(canonicalProductJson(events)).byteLength,
        Math.min(...events.map((e) => e.occurred_at)),
        Math.max(...events.map((e) => e.occurred_at)),
        now,
        now + 600000,
        now + 600000,
      ),
  ];
  for (const event of events)
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO product_event_claims(workspace_id,app_id,environment_id,channel,event_id,digest,reservation)
    SELECT ?,?,?,?,?,?,reservation FROM product_batches WHERE workspace_id=? AND app_id=? AND environment_id=? AND channel=? AND batch_id=?`,
        )
        .bind(
          ...identity(scope, event.event_id),
          await productDigest(event),
          ...identity(scope, batch),
        ),
    );
  statements.push(
    db
      .prepare(
        'SELECT * FROM product_batches WHERE workspace_id=? AND app_id=? AND environment_id=? AND channel=? AND batch_id=?',
      )
      .bind(...identity(scope, batch)),
  );
  const result = await db.batch(statements);
  if (result.some((row) => !row.success)) throw new ProductError('Product reservation failed');
  const receipt = result.at(-1)?.results?.[0] as ProductReceipt | undefined;
  if (!receipt) throw new ProductError('Product reservation missing');
  const owned = await db
    .prepare('SELECT event_id FROM product_event_claims WHERE reservation=?')
    .bind(receipt.reservation)
    .all<{ event_id: string }>();
  const ids = new Set(owned.results.map((e) => e.event_id));
  return { receipt, events: events.filter((e) => ids.has(e.event_id)) };
}
export async function sealProductBatch(
  db: D1DatabaseLike,
  receipt: ProductReceipt,
  hash: string,
  bytes: number,
  count: number,
) {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE product_batches SET state='sealed',object_hash=?,object_bytes=?,accepted_count=?,expires_at=?,cleanup_at=?
   WHERE reservation=? AND state='pending' AND expires_at>? AND (SELECT COUNT(*) FROM product_event_claims WHERE reservation=?)=?`,
      )
      .bind(
        hash,
        bytes,
        count,
        receipt.received_at + 35 * 86400000,
        receipt.received_at + 31 * 86400000,
        receipt.reservation,
        Date.now(),
        receipt.reservation,
        count,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO product_report_segments(id,workspace_id,app_id,environment_id,channel,event_day,level,format,reservation,batch_id,object_key,object_hash,object_bytes,event_count,min_time,max_time,received_at,active,cleanup_at)
     SELECT reservation,workspace_id,app_id,environment_id,channel,CAST(received_at/86400000 AS INTEGER),0,1,reservation,batch_id,object_key,object_hash,object_bytes,accepted_count,min_time,max_time,received_at,1,received_at+2678400000
     FROM product_batches WHERE reservation=? AND state='sealed' AND object_hash=? AND accepted_count>0 AND object_deleted=0`,
      )
      .bind(receipt.reservation, hash),
  ]);
  const result = results[0];
  if (result.meta.changes) return true;
  const existing = await db
    .prepare('SELECT state,object_hash FROM product_batches WHERE reservation=?')
    .bind(receipt.reservation)
    .first<{ state: string; object_hash: string }>();
  if (existing?.state !== 'sealed' || existing.object_hash !== hash)
    throw new ProductError('Product reservation changed or expired; retry');
  return false;
}
