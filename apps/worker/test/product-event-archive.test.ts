import { afterEach, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { ProductEventV1 } from '@app-health/contracts';
import { analysisDatabase } from './analysis-sqlite.js';
import { acceptProductArchive, readProductArchive } from '../src/product-event-archive.js';
import { reserveProductBatch, sealProductBatch } from '../src/product-event-reservation.js';
import { cleanupProductArchive } from '../src/product-event-cleanup.js';
import {
  normalizedProductEvents,
  type ProductBucket,
  type ProductScope,
} from '../src/product-event-model.js';

const scope: ProductScope = {
  workspace: 'ws',
  app_id: 'app',
  environment_id: 'env',
  channel: 'server',
};
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const event = (number = 1) =>
  ProductEventV1.parse({
    schemaVersion: 'app-health.product-event.v1',
    event_id: id(number),
    occurred_at: Date.now(),
    type: 'event',
    name: 'Order Paid',
    channel: 'server',
    properties: { plan: 'Pro' },
  });
const instances: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.dispose()));
});
async function fixture() {
  const database = analysisDatabase();
  const runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-22',
    r2Buckets: ['HISTORY'],
  });
  instances.push(runtime);
  const bucket = (await runtime.getR2Bucket('HISTORY')) as unknown as ProductBucket;
  return { ...database, bucket };
}

describe('canonical product archive with real SQLite and local R2', () => {
  it('seals only durable bytes, retries lost R2 responses and excludes duplicate-only receipts from report segments', async () => {
    const { db, sqlite, bucket } = await fixture();
    try {
      const events = [event()];
      let once = true;
      const lost: ProductBucket = {
        get: bucket.get.bind(bucket),
        put: async (...args) => {
          const result = await bucket.put(...args);
          if (once) {
            once = false;
            throw new Error('lost put response');
          }
          return result;
        },
      };
      await expect(acceptProductArchive(db, lost, scope, id(10), events)).rejects.toThrow(
        'lost put response',
      );
      expect(sqlite.prepare('SELECT state FROM product_batches').get()).toMatchObject({
        state: 'pending',
      });
      await expect(acceptProductArchive(db, bucket, scope, id(11), events)).rejects.toThrow(
        'original pending',
      );
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
        n: 1,
      });
      expect(await acceptProductArchive(db, bucket, scope, id(10), events)).toMatchObject({
        accepted: 1,
        duplicates: 0,
      });
      expect(await acceptProductArchive(db, bucket, scope, id(11), events)).toMatchObject({
        accepted: 0,
        duplicates: 1,
      });
      const result = await readProductArchive(db, bucket, scope, 0, Date.now() + 1000);
      expect(result.objects).toBe(1);
      expect(result.facts).toHaveLength(1);
      expect(result.pending).toBe(0);
      expect((await bucket.list!({ prefix: 'product-events/v1/' })).objects).toHaveLength(1);
      expect(await acceptProductArchive(db, bucket, scope, id(10), events)).toMatchObject({
        accepted: 0,
        duplicates: 1,
      });
    } finally {
      sqlite.close();
    }
  });
  it('atomically rejects a conflicting event or batch without poisoning later claims and isolates channels/scopes', async () => {
    const { db, sqlite, bucket } = await fixture();
    try {
      const first = event();
      await acceptProductArchive(db, bucket, scope, id(10), [first]);
      await expect(
        acceptProductArchive(db, bucket, scope, id(11), [event(2), { ...first, name: 'Changed' }]),
      ).rejects.toThrow('identity conflict');
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_event_claims').get()).toMatchObject({
        n: 1,
      });
      await expect(
        acceptProductArchive(db, bucket, scope, id(10), [{ ...first, name: 'Changed' }]),
      ).rejects.toThrow('identity conflict');
      expect(await acceptProductArchive(db, bucket, scope, id(12), [event(2)])).toMatchObject({
        accepted: 1,
      });
      expect(
        await acceptProductArchive(db, bucket, { ...scope, channel: 'manual' }, id(10), [
          { ...first, channel: 'manual' },
        ]),
      ).toMatchObject({ accepted: 1 });
      expect(
        (
          await readProductArchive(
            db,
            bucket,
            { ...scope, workspace: 'foreign' },
            0,
            Date.now() + 1000,
          )
        ).facts,
      ).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
  it('binds immutable object bytes, scope and manifest; missing/corrupt objects and bounded readers never return zeros', async () => {
    const { db, sqlite, bucket } = await fixture();
    try {
      await acceptProductArchive(db, bucket, scope, id(10), [event()]);
      const row = sqlite.prepare('SELECT object_key FROM product_batches').get() as {
        object_key: string;
      };
      await expect(
        readProductArchive(db, bucket, scope, 0, Date.now() + 1000, {
          objects: 0,
          bytes: 8 * 1024 * 1024,
        }),
      ).rejects.toThrow('segment limit');
      await expect(
        readProductArchive(db, bucket, scope, 0, Date.now() + 1000, { objects: 200, bytes: 1 }),
      ).rejects.toThrow('byte limit');
      const object = await bucket.get(row.object_key);
      const bytes = new Uint8Array(await object!.arrayBuffer());
      bytes[0] = 32;
      await bucket.put(row.object_key, bytes);
      await expect(readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).rejects.toThrow(
        'checksum',
      );
      await bucket.delete!(row.object_key);
      await expect(readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).rejects.toThrow(
        'missing',
      );
    } finally {
      sqlite.close();
    }
  });
  it('fences expired reservations and retains raw coverage for 31 days, identity receipts for 35 days', async () => {
    const { db, sqlite, bucket } = await fixture();
    try {
      const events = [event()];
      const pending = await reserveProductBatch(db, scope, id(10), events);
      sqlite.prepare('UPDATE product_batches SET expires_at=0').run();
      await expect(sealProductBatch(db, pending.receipt, 'a'.repeat(64), 1, 1)).rejects.toThrow(
        'expired',
      );
      await cleanupProductArchive(db, bucket);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_event_claims').get()).toMatchObject({
        n: 0,
      });
      await acceptProductArchive(db, bucket, scope, id(10), events);
      await cleanupProductArchive(db, bucket, Date.now() + 31 * 86400000 + 1000);
      expect((await bucket.list!({ prefix: 'product-events/v1/' })).objects).toHaveLength(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_event_claims').get()).toMatchObject({
        n: 1,
      });
      await cleanupProductArchive(db, bucket, Date.now() + 35 * 86400000 + 1000);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
        n: 0,
      });
    } finally {
      sqlite.close();
    }
  });
  it('hashes opted-in anonymous IDs identically to browser scope without deriving any identity', async () => {
    const source = { ...event(), visitor_id: id(1), session_id: id(2) };
    const normalized = await normalizedProductEvents(scope, [source, source]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].visitor_id).toMatch(/^[a-f0-9]{64}$/);
    expect(normalized[0].session_id).not.toBe(id(2));
    const different = await normalizedProductEvents({ ...scope, environment_id: 'other' }, [
      source,
    ]);
    expect(different[0].visitor_id).not.toBe(normalized[0].visitor_id);
  });
});

it('enforces daily capacity atomically while permitting exact retries and leaves no poisoned batch on overflow', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    const first = event();
    await acceptProductArchive(db, bucket, scope, id(10), [first]);
    sqlite.prepare('UPDATE product_event_days SET events=4999').run();
    await expect(
      acceptProductArchive(db, bucket, scope, id(11), [event(2), event(3)]),
    ).rejects.toThrow('CHECK constraint failed');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 1,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_event_claims').get()).toMatchObject({
      n: 1,
    });
    expect(await acceptProductArchive(db, bucket, scope, id(10), [first])).toMatchObject({
      accepted: 0,
      duplicates: 1,
    });
    expect(await acceptProductArchive(db, bucket, scope, id(12), [event(2)])).toMatchObject({
      accepted: 1,
    });
    await expect(acceptProductArchive(db, bucket, scope, id(13), [event(3)])).rejects.toThrow(
      'CHECK constraint failed',
    );
  } finally {
    sqlite.close();
  }
});
