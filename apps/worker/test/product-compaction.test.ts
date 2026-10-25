import { afterEach, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { analysisDatabase } from './analysis-sqlite.js';
import {
  acceptProductArchive,
  readProductArchive,
  readProductObject,
} from '../src/product-event-archive.js';
import { compactProductArchive } from '../src/product-compaction.js';
import {
  maintainProductArchive,
  consumeProductMaintenance,
  type ProductCleanupWake,
} from '../src/product-event-maintenance.js';
import type { ProductEnvironment } from '../src/product-event-model.js';
import { cleanupProductArchive } from '../src/product-event-cleanup.js';
import { ProductEventV1 } from '@app-health/contracts';
import type { ProductBucket, ProductScope } from '../src/product-event-model.js';
import type { ProductSegment } from '../src/product-segment-model.js';
let runtime: Miniflare;
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.dispose();
});
const scope: ProductScope = {
  workspace: 'ws',
  app_id: 'app',
  environment_id: 'env',
  channel: 'server',
};
async function fixture() {
  runtime = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    r2Buckets: ['HISTORY'],
  });
  return {
    ...analysisDatabase(),
    bucket: (await runtime.getR2Bucket('HISTORY')) as unknown as ProductBucket,
  };
}
function event() {
  return ProductEventV1.parse({
    schemaVersion: 'app-health.product-event.v1',
    event_id: crypto.randomUUID(),
    occurred_at: Date.now(),
    channel: 'server',
    type: 'revenue',
    name: 'Order Paid',
    properties: { zero: 0, enabled: false },
    revenue: { currency: 'USD', amount_minor: 125 },
  });
}
async function seed(
  db: ReturnType<typeof analysisDatabase>['db'],
  bucket: ProductBucket,
  count: number,
) {
  for (let i = 0; i < count; i++)
    await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [event()]);
}
it('compacts 500 single-event SDK flushes with exact immutable facts and bounded readers', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 500);
    await expect(readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).rejects.toThrow(
      'segment limit',
    );
    const old = sqlite
      .prepare('SELECT * FROM product_report_segments ORDER BY object_bytes,id LIMIT 1')
      .get() as ProductSegment;
    for (let i = 0; i < 20; i++) if (!(await compactProductArchive(db, bucket)).more) break;
    const report = await readProductArchive(db, bucket, scope, 0, Date.now() + 1000);
    expect(report.facts).toHaveLength(500);
    expect(report.objects).toBeLessThan(64);
    expect(new Set(report.facts.map((f) => f.event.event_id)).size).toBe(500);
    expect(
      report.facts.every(
        (f) =>
          f.event.name === 'Order Paid' &&
          f.event.properties?.zero === 0 &&
          f.event.properties?.enabled === false,
      ),
    ).toBe(true);
    expect(report.facts.reduce((n, f) => n + (f.event.revenue?.amount_minor ?? 0), 0)).toBe(62500);
    expect(await readProductObject(bucket, old, { total: 0, limit: 1048576 })).toHaveLength(1);
    for (let i = 0; i < 6; i++) await cleanupProductArchive(db, bucket, Date.now() + 3600001);
    await expect(readProductObject(bucket, old, { total: 0, limit: 1048576 })).rejects.toThrow(
      'changed',
    );
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(
      500,
    );
    await expect(
      readProductArchive(db, bucket, scope, 0, Date.now() + 1000, { objects: 200, bytes: 1 }),
    ).rejects.toThrow('byte limit');
  } finally {
    sqlite.close();
  }
}, 30000);
it('keeps closed-day tails compact and does not extend retention', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 65);
    const before = sqlite
      .prepare('SELECT MAX(received_at) AS n FROM product_report_segments')
      .get() as { n: number };
    for (let i = 0; i < 4; i++) if (!(await compactProductArchive(db, bucket)).more) break;
    expect(sqlite.prepare('SELECT dirty FROM product_compaction_jobs').get()).toMatchObject({
      dirty: 0,
    });
    sqlite.exec(
      'UPDATE product_report_segments SET event_day=event_day-1; UPDATE product_compaction_jobs SET event_day=event_day-1',
    );
    for (let i = 0; i < 5; i++) if (!(await compactProductArchive(db, bucket)).more) break;
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).objects).toBe(1);
    expect(
      sqlite
        .prepare('SELECT received_at,cleanup_at FROM product_report_segments WHERE active=1')
        .get(),
    ).toMatchObject({ received_at: before.n, cleanup_at: before.n + 31 * 86400000 });
    await cleanupProductArchive(db, bucket, Date.now() + 31 * 86400000 + 1000);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM product_report_segments WHERE active=1').get(),
    ).toMatchObject({ n: 0 });
  } finally {
    sqlite.close();
  }
}, 30000);
it('lost uploads, expired publishers and concurrent acceptance preserve the previous complete snapshot', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 32);
    let first = true;
    const lost: ProductBucket = {
      get: bucket.get.bind(bucket),
      put: async (...args) => {
        const result = await bucket.put(...args);
        if (first) {
          first = false;
          throw new Error('lost upload response');
        }
        return result;
      },
    };
    await expect(compactProductArchive(db, lost)).rejects.toThrow('lost upload');
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(
      32,
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_object_gc').get()).toMatchObject({
      n: 1,
    });
    const expired: ProductBucket = {
      get: bucket.get.bind(bucket),
      put: async (...args) => {
        const result = await bucket.put(...args);
        sqlite.exec('UPDATE product_compaction_jobs SET lease_until=0');
        return result;
      },
    };
    expect((await compactProductArchive(db, expired)).published).toBe(false);
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).objects).toBe(32);
    let injected = false;
    const concurrent: ProductBucket = {
      get: async (key) => {
        if (!injected) {
          injected = true;
          await seed(db, bucket, 1);
        }
        return bucket.get(key);
      },
      put: bucket.put.bind(bucket),
    };
    expect((await compactProductArchive(db, concurrent)).published).toBe(true);
    expect((await readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).facts).toHaveLength(
      33,
    );
    expect(sqlite.prepare('SELECT dirty FROM product_compaction_jobs').get()).toMatchObject({
      dirty: 1,
    });
  } finally {
    sqlite.close();
  }
}, 30000);

it('finishes bounded compaction through durable queued continuations with no report or dashboard request', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 96);
    const pending: ProductCleanupWake[] = [];
    const env = {
      DB: db,
      BROWSER_HISTORY: bucket,
      BROWSER_EVENTS: {
        send: async (wake: ProductCleanupWake) => {
          pending.push(wake);
        },
      },
    } as unknown as ProductEnvironment;
    await maintainProductArchive(env);
    let deliveries = 0;
    while (pending.length && deliveries < 10) {
      const message = { body: pending.shift()!, ack: vi.fn(), retry: vi.fn() };
      await consumeProductMaintenance([message], env);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      deliveries++;
    }
    expect(deliveries).toBe(4);
    expect(pending).toHaveLength(0);
    const report = await readProductArchive(db, bucket, scope, 0, Date.now() + 1000);
    expect(report.objects).toBe(3);
    expect(report.facts).toHaveLength(96);
  } finally {
    sqlite.close();
  }
}, 30000);
