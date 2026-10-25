import { reserveProductBatch, sealProductBatch } from '../src/product-event-reservation.js';
import { cleanupProductArchive } from '../src/product-event-cleanup.js';
import { splitMigrationSql } from './migration-sql.js';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { ProductEventV1 } from '@app-health/contracts';
import { acceptProductArchive, readProductArchive } from '../src/product-event-archive.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';
import type { ProductBucket, ProductScope } from '../src/product-event-model.js';

let runtime: Miniflare;
afterEach(async () => {
  await runtime?.dispose();
});
it('atomically reserves concurrent identities in actual workerd D1 and seals real R2 without double acceptance or partial conflicts', async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ['DB'],
    r2Buckets: ['HISTORY'],
  });
  const db = (await runtime.getD1Database('DB')) as D1DatabaseLike,
    bucket = (await runtime.getR2Bucket('HISTORY')) as unknown as ProductBucket;
  for (const migration of ['0034_product_events.sql', '0036_product_capacity.sql']) {
    const sql = await readFile(new URL('../migrations/' + migration, import.meta.url), 'utf8');
    for (const statement of splitMigrationSql(sql)) await db.prepare(statement).run();
  }
  const scope: ProductScope = {
    workspace: 'workspace',
    app_id: 'app',
    environment_id: 'env',
    channel: 'server',
  };
  const event = ProductEventV1.parse({
    schemaVersion: 'app-health.product-event.v1',
    event_id: crypto.randomUUID(),
    occurred_at: Date.now(),
    channel: 'server',
    type: 'event',
    name: 'Signup',
  });
  const batch = crypto.randomUUID();
  const equal = await Promise.all([
    acceptProductArchive(db, bucket, scope, batch, [event]),
    acceptProductArchive(db, bucket, scope, batch, [event]),
  ]);
  // Only the winning seal reports newly accepted facts.
  expect(equal.reduce((sum, result) => sum + result.accepted, 0)).toBe(1);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM product_event_claims').first()).toMatchObject({
    n: 1,
  });
  expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(1);
  const newEvent = { ...event, event_id: crypto.randomUUID() };
  await expect(
    acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [
      newEvent,
      { ...event, name: 'Conflict' },
    ]),
  ).rejects.toThrow('identity conflict');
  expect(await db.prepare('SELECT COUNT(*) AS n FROM product_event_claims').first()).toMatchObject({
    n: 1,
  });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM product_batches').first()).toMatchObject({
    n: 1,
  });
  const second = await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [
    event,
    newEvent,
  ]);
  expect(second).toMatchObject({ accepted: 1, duplicates: 1 });
  const competing = { ...event, event_id: crypto.randomUUID() };
  const attempts = await Promise.allSettled([
    acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [competing]),
    acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [
      { ...competing, name: 'Conflicting concurrent' },
    ]),
  ]);
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(3);
  const pendingBatch = crypto.randomUUID(),
    pendingEvent = { ...event, event_id: crypto.randomUUID() };
  const pending = await reserveProductBatch(db, scope, pendingBatch, [pendingEvent]);
  await db
    .prepare('UPDATE product_batches SET expires_at=0,cleanup_at=0 WHERE reservation=?')
    .bind(pending.receipt.reservation)
    .run();
  expect(await acceptProductArchive(db, bucket, scope, pendingBatch, [pendingEvent])).toMatchObject(
    { accepted: 1 },
  );
  await expect(sealProductBatch(db, pending.receipt, 'a'.repeat(64), 1, 1)).rejects.toThrow(
    'expired',
  );
  expect(await db.prepare('SELECT COUNT(*) AS n FROM product_object_gc').first()).toMatchObject({
    n: 1,
  });
  await cleanupProductArchive(db, bucket);
  expect(
    await bucket.put(pending.receipt.object_key, 'late', { onlyIf: { etagDoesNotMatch: '*' } }),
  ).toBeNull();
}, 30000);
