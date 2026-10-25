import { ProductEventV1 } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import {
  canonicalProductJson,
  productDigest,
  ProductError,
  type ProductScope,
  type ProductBucket,
  type ProductReceipt,
  type ProductFact,
} from './product-event-model.js';

import { reserveProductBatch, sealProductBatch } from './product-event-reservation.js';

async function rawDigest(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
async function persistedObject(bucket: ProductBucket, key: string, body: string, hash: string) {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength > 98304)
    throw new ProductError('Canonical product batch exceeds archive size', 413);
  const created = await bucket.put(key, bytes, {
    onlyIf: { etagDoesNotMatch: '*' },
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { sha256: hash },
  });
  if (created) return;
  const object = await bucket.get(key);
  if (!object || object.size !== bytes.byteLength) {
    await object?.body.cancel();
    throw new ProductError('Product archive object missing or changed');
  }
  if ((await rawDigest(await object.arrayBuffer())) !== hash)
    throw new ProductError('Product archive object integrity mismatch');
}
export async function acceptProductArchive(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  scope: ProductScope,
  batch: string,
  events: ProductEventV1[],
) {
  const reserved = await reserveProductBatch(db, scope, batch, events),
    { receipt } = reserved;
  if (receipt.state === 'sealed')
    return { schema_version: 1, accepted: 0, duplicates: events.length };
  const envelope = {
    schema_version: 1,
    scope,
    batch_id: batch,
    reservation: receipt.reservation,
    events: reserved.events,
  };
  const body = canonicalProductJson(envelope),
    hash = await productDigest(envelope);
  if (reserved.events.length) await persistedObject(bucket, receipt.object_key, body, hash);
  // Zero-owned receipts rely on the reservation trigger's already-sealed originals; they have no report object.
  const newlySealed = await sealProductBatch(
    db,
    receipt,
    hash,
    new TextEncoder().encode(body).byteLength,
    reserved.events.length,
  );
  return {
    schema_version: 1,
    accepted: newlySealed ? reserved.events.length : 0,
    duplicates: events.length - (newlySealed ? reserved.events.length : 0),
  };
}
async function readProductObject(
  bucket: ProductBucket,
  receipt: ProductReceipt,
  bytes: { total: number; limit: number },
): Promise<ProductFact[]> {
  const object = await bucket.get(receipt.object_key);
  if (!object || object.size !== receipt.object_bytes || object.size > 98304) {
    await object?.body.cancel();
    throw new ProductError('Product history object missing or changed');
  }
  bytes.total += object.size;
  if (bytes.total > bytes.limit) {
    await object.body.cancel();
    throw new ProductError('Combined conversion byte limit exceeded');
  }
  const rawBytes = await object.arrayBuffer();
  if ((await rawDigest(rawBytes)) !== receipt.object_hash)
    throw new ProductError('Product history checksum mismatch');
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rawBytes);
  const envelope = JSON.parse(raw) as {
    schema_version: number;
    scope: ProductScope;
    batch_id: string;
    reservation: string;
    events: unknown[];
  };

  const scope: ProductScope = {
    workspace: receipt.workspace_id,
    app_id: receipt.app_id,
    environment_id: receipt.environment_id,
    channel: receipt.channel,
  };
  if (
    envelope.schema_version !== 1 ||
    canonicalProductJson(envelope.scope) !== canonicalProductJson(scope) ||
    envelope.batch_id !== receipt.batch_id ||
    envelope.reservation !== receipt.reservation ||
    envelope.events.length !== receipt.accepted_count
  )
    throw new ProductError('Product history manifest mismatch');
  return envelope.events.map((value) => ({ scope, event: ProductEventV1.parse(value) }));
}
type ProductReadBudget = { objects: number; bytes: number };
const DEFAULT_READ_BUDGET: ProductReadBudget = { objects: 200, bytes: 8 * 1024 * 1024 };
export async function readProductArchive(
  db: D1DatabaseLike,
  bucket: ProductBucket,
  scope: { workspace: string; app_id: string; environment_id: string },
  from: number,
  to: number,
  budget: ProductReadBudget = DEFAULT_READ_BUDGET,
) {
  const rows = await db
    .prepare(
      `SELECT * FROM product_batches WHERE workspace_id=? AND app_id=? AND environment_id=? AND state='sealed' AND accepted_count>0 AND min_time<? AND max_time>=? ORDER BY received_at,reservation LIMIT 201`,
    )
    .bind(scope.workspace, scope.app_id, scope.environment_id, to, from)
    .all<ProductReceipt>();
  if (rows.results.length > budget.objects)
    throw new ProductError('Combined conversion segment limit exceeded; choose a shorter period');
  const pending = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM product_batches WHERE workspace_id=? AND app_id=? AND environment_id=? AND state='pending' AND min_time<? AND max_time>=?`,
    )
    .bind(scope.workspace, scope.app_id, scope.environment_id, to, from)
    .first<{ n: number }>();
  const facts: ProductFact[] = [],
    bytes = { total: 0, limit: budget.bytes },
    deadline = performance.now() + 15000;
  for (const row of rows.results) {
    if (performance.now() > deadline) throw new ProductError('Product history time limit exceeded');
    facts.push(
      ...(await readProductObject(bucket, row, bytes)).filter(
        (f) => f.event.occurred_at >= from && f.event.occurred_at < to,
      ),
    );
    if (facts.length > 50000) throw new ProductError('Combined conversion event limit exceeded');
  }
  return { facts, objects: rows.results.length, bytes: bytes.total, pending: pending?.n ?? 0 };
}
