import { afterEach, describe, expect, it, vi } from 'vitest';
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
      sqlite.prepare('UPDATE product_batches SET expires_at=0,cleanup_at=0').run();
      await expect(sealProductBatch(db, pending.receipt, 'a'.repeat(64), 1, 1)).rejects.toThrow(
        'expired',
      );
      await cleanupProductArchive(db, bucket);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_event_claims').get()).toMatchObject({
        n: 0,
      });
      await acceptProductArchive(db, bucket, scope, id(10), events);
      await cleanupProductArchive(db, bucket, Date.now() + 31 * 86400000 + 1000);
      const sealedKey = (
        sqlite.prepare("SELECT object_key FROM product_batches WHERE state='sealed'").get() as {
          object_key: string;
        }
      ).object_key;
      expect(await bucket.get(sealedKey)).toBeNull();
      expect(await (await bucket.get(pending.receipt.object_key))!.text()).toContain(
        'expired_product_reservation',
      );
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

it('reclaims expired pending identities inline with a fresh nonce and tracks/fences stale R2 uploads', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    const events = [event()],
      first = await reserveProductBatch(db, scope, id(10), events);
    sqlite.prepare('UPDATE product_batches SET expires_at=0,cleanup_at=0').run();
    const retry = await reserveProductBatch(db, scope, id(10), events);
    expect(retry.receipt.reservation).not.toBe(first.receipt.reservation);
    await bucket.put(first.receipt.object_key, 'stale unaccepted upload', {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    await expect(sealProductBatch(db, first.receipt, 'a'.repeat(64), 1, 1)).rejects.toThrow(
      'expired',
    );
    expect(sqlite.prepare('SELECT object_key FROM product_object_gc').get()).toMatchObject({
      object_key: first.receipt.object_key,
    });
    await cleanupProductArchive(db, bucket);
    expect(
      await bucket.put(first.receipt.object_key, 'even later stale upload', {
        onlyIf: { etagDoesNotMatch: '*' },
      }),
    ).toBeNull();
    expect(await acceptProductArchive(db, bucket, scope, id(10), events)).toMatchObject({
      accepted: 1,
    });
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(
      1,
    );
  } finally {
    sqlite.close();
  }
});
it('reserves sustainable35-day tenant-local headroom without global cross-tenant admission coupling', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await acceptProductArchive(db, bucket, scope, id(10), [event()]);
    sqlite
      .prepare(
        "UPDATE product_event_usage SET claims=175000,receipts=175000 WHERE scope='a:ws:app'",
      )
      .run();
    sqlite
      .prepare("UPDATE product_event_usage SET claims=875000,receipts=875000 WHERE scope='w:ws'")
      .run();
    sqlite.prepare("INSERT INTO product_event_usage VALUES('global',999999999,999999999)").run();
    expect(await acceptProductArchive(db, bucket, scope, id(11), [event(2)])).toMatchObject({
      accepted: 1,
    });
    sqlite.prepare("UPDATE product_event_usage SET claims=185000 WHERE scope='a:ws:app'").run();
    await expect(acceptProductArchive(db, bucket, scope, id(12), [event(3)])).rejects.toThrow(
      'retained capacity',
    );
    expect(
      await acceptProductArchive(db, bucket, { ...scope, workspace: 'another-workspace' }, id(12), [
        event(3),
      ]),
    ).toMatchObject({ accepted: 1 });
    sqlite
      .prepare('UPDATE product_workspace_days SET events=25000 WHERE workspace_id=?')
      .run('another-workspace');
    await expect(
      acceptProductArchive(db, bucket, { ...scope, workspace: 'another-workspace' }, id(13), [
        event(4),
      ]),
    ).rejects.toThrow('workspace daily capacity');
  } finally {
    sqlite.close();
  }
});

it('refunds expired pending admission exactly once so a near-quota retry is not charged twice', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    const events = Array.from({ length: 100 }, (_, i) => event(i + 1));
    const reserved = await reserveProductBatch(db, scope, id(1000), events);
    sqlite.prepare('UPDATE product_event_days SET events=4950').run();
    sqlite.prepare('UPDATE product_workspace_days SET events=24950').run();
    sqlite
      .prepare('UPDATE product_batches SET expires_at=0 WHERE reservation=?')
      .run(reserved.receipt.reservation);
    expect(await acceptProductArchive(db, bucket, scope, id(1000), events)).toMatchObject({
      accepted: 100,
    });
    expect(sqlite.prepare('SELECT events FROM product_event_days').get()).toMatchObject({
      events: 4950,
    });
    expect(sqlite.prepare('SELECT events FROM product_workspace_days').get()).toMatchObject({
      events: 24950,
    });
  } finally {
    sqlite.close();
  }
});
it('excludes sibling expired pending work, allows37-date retained headroom and protects fresh raw objects with stale cleanup indexes', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    for (let n = 0; n < 128; n++)
      sqlite
        .prepare(
          `INSERT INTO product_batches(workspace_id,app_id,environment_id,channel,batch_id,digest,reservation,state,object_key,input_count,input_bytes,min_time,max_time,received_at,expires_at)
   VALUES('ws',?,'env','server',?, ?,?,'pending',?,1,1,0,0,0,0)`,
        )
        .run(
          'sibling-' + Math.floor(n / 32),
          'old-' + n,
          'a'.repeat(64),
          'old-' + n,
          'product-events/v1/old-' + n,
        );
    await acceptProductArchive(db, bucket, scope, id(10), [event()]);
    sqlite
      .prepare(
        "UPDATE product_event_usage SET claims=180000,receipts=180000 WHERE scope='a:ws:app'",
      )
      .run();
    sqlite
      .prepare("UPDATE product_event_usage SET claims=900000,receipts=900000 WHERE scope='w:ws'")
      .run();
    expect(await acceptProductArchive(db, bucket, scope, id(11), [event(2)])).toMatchObject({
      accepted: 1,
    });
    sqlite.prepare("UPDATE product_batches SET cleanup_at=0 WHERE state='sealed'").run();
    await cleanupProductArchive(db, bucket);
    const fresh = sqlite
      .prepare(
        "SELECT object_key,object_deleted,cleanup_at FROM product_batches WHERE state='sealed'",
      )
      .all() as Array<{ object_key: string; object_deleted: number; cleanup_at: number }>;
    expect(fresh).toHaveLength(2);
    for (const row of fresh) {
      expect(await bucket.get(row.object_key)).not.toBeNull();
      expect(row.object_deleted).toBe(0);
      expect(row.cleanup_at).toBeGreaterThan(Date.now());
    }
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM product_event_claims WHERE app_id='app'").get(),
    ).toMatchObject({ n: 2 });
  } finally {
    sqlite.close();
  }
});

it('refunds the original UTC admission day across midnight and derives cleanup safely with recursive triggers', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    sqlite.exec('PRAGMA recursive_triggers=ON');
    const current = Date.now(),
      previous = Math.floor(current / 86400000) * 86400000 - 1;
    const events = [event()],
      clock = vi.spyOn(Date, 'now').mockReturnValue(previous);
    let original;
    try {
      original = await reserveProductBatch(db, scope, id(10), events);
    } finally {
      clock.mockRestore();
    }
    sqlite
      .prepare('UPDATE product_batches SET expires_at=0 WHERE reservation=?')
      .run(original.receipt.reservation);
    await acceptProductArchive(db, bucket, scope, id(10), events);
    expect(
      sqlite
        .prepare('SELECT events FROM product_event_days WHERE day=?')
        .get(Math.floor(previous / 86400000)),
    ).toMatchObject({ events: 0 });
    expect(
      sqlite
        .prepare('SELECT events FROM product_event_days WHERE day=?')
        .get(Math.floor(current / 86400000)),
    ).toMatchObject({ events: 1 });
    expect(
      sqlite
        .prepare('SELECT events FROM product_workspace_days WHERE day=?')
        .get(Math.floor(previous / 86400000)),
    ).toMatchObject({ events: 0 });
  } finally {
    vi.restoreAllMocks();
    sqlite.close();
  }
});
