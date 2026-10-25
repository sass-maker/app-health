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
  target: ProductScope = scope,
) {
  for (let i = 0; i < count; i++)
    await acceptProductArchive(db, bucket, target, crypto.randomUUID(), [event()]);
}
it('compacts 500 single-event SDK flushes with exact immutable facts and bounded readers', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 500);
    await expect(readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).rejects.toThrow(
      'segment limit',
    );
    const old = sqlite
      .prepare('SELECT * FROM product_report_segments ORDER BY received_at,object_bytes,id LIMIT 1')
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
      .prepare('SELECT MIN(received_at) AS n FROM product_report_segments')
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
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(await compactProductArchive(db, lost)).toMatchObject({ failed: true, published: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith('{"event":"product_compaction_failed"}');
    expect(
      sqlite.prepare('SELECT retry_at,error_code FROM product_compaction_jobs').get(),
    ).toMatchObject({ error_code: 'compaction_failed' });
    expect((await compactProductArchive(db, bucket)).published).toBe(false);
    sqlite.exec('UPDATE product_compaction_jobs SET retry_at=0');
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

it('backs off a poisoned oldest job while queued cleanup and another scope continue independently', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    await seed(db, bucket, 32);
    sqlite.exec(
      'UPDATE product_report_segments SET event_day=event_day-1; UPDATE product_compaction_jobs SET event_day=event_day-1',
    );
    const bad = sqlite.prepare('SELECT object_key FROM product_report_segments LIMIT 1').get() as {
      object_key: string;
    };
    await bucket.put(bad.object_key, 'private malformed bytes must never become a diagnostic');
    const healthy = { ...scope, app_id: 'other-app', environment_id: 'other-env' };
    await seed(db, bucket, 32, healthy);
    sqlite.exec(
      `WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<150) INSERT INTO product_object_gc SELECT 'product-events/v1/queued-garbage-'||v,0,'fence' FROM n`,
    );
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
    expect(pending).toHaveLength(0);
    const issue = sqlite
      .prepare("SELECT retry_at,error_code FROM product_compaction_jobs WHERE app_id='app'")
      .get() as { retry_at: number; error_code: string };
    expect(issue.error_code).toBe('compaction_failed');
    expect(issue.retry_at).toBeGreaterThan(Date.now());
    expect(issue.retry_at).toBeLessThanOrEqual(Date.now() + 15 * 60000);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM product_object_gc WHERE phase='fence' AND cleanup_at<=?",
        )
        .get(Date.now()),
    ).toMatchObject({ n: 0 });
    const report = await readProductArchive(db, bucket, healthy, 0, Date.now() + 1000);
    expect(report.objects).toBe(1);
    expect(report.facts).toHaveLength(32);
    await expect(readProductArchive(db, bucket, scope, 0, Date.now() + 1000)).rejects.toThrow(
      'changed',
    );
  } finally {
    sqlite.close();
  }
}, 30000);
it('anchors derived expiry to earliest hours-apart receipts and leaves incompatible future-skew facts in their original snapshot', async () => {
  const { db, sqlite, bucket } = await fixture();
  const day = 86400000,
    base = Math.floor(Date.now() / day) * day - 2 * day;
  const clock = vi.spyOn(Date, 'now');
  const at = async (time: number, future = 0) => {
    clock.mockReturnValue(time);
    const value = event();
    value.occurred_at += future;
    await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [value]);
  };
  try {
    await at(base + 3600000);
    await at(base + 20 * 3600000, 60000);
    clock.mockRestore();
    expect((await compactProductArchive(db, bucket)).published).toBe(true);
    expect(
      sqlite
        .prepare('SELECT received_at,cleanup_at FROM product_report_segments WHERE active=1')
        .get(),
    ).toMatchObject({ received_at: base + 3600000, cleanup_at: base + 3600000 + 31 * day });
    const nextClock = vi.spyOn(Date, 'now');
    nextClock.mockReturnValue(base);
    await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [event()]);
    nextClock.mockReturnValue(base + day - 60001);
    let value = event();
    value.occurred_at += 60000;
    await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [value]);
    nextClock.mockReturnValue(base + day - 1);
    value = event();
    value.occurred_at += 60000;
    const future = value.event_id;
    await acceptProductArchive(db, bucket, scope, crypto.randomUUID(), [value]);
    nextClock.mockRestore();
    expect((await compactProductArchive(db, bucket)).published).toBe(true);
    const derived = sqlite
      .prepare(
        'SELECT received_at,cleanup_at,max_time FROM product_report_segments WHERE active=1 AND format=2',
      )
      .get() as { received_at: number; cleanup_at: number; max_time: number };
    expect(derived.received_at).toBe(base);
    expect(derived.cleanup_at).toBe(base + 31 * day);
    expect(derived.cleanup_at).toBeGreaterThanOrEqual(derived.max_time + 30 * day);
    const report = await readProductArchive(db, bucket, scope, 0, Date.now() + 1000);
    expect(report.objects).toBe(2);
    expect(report.facts).toHaveLength(5);
    expect(report.facts.some((f) => f.event.event_id === future)).toBe(true);
    const remaining = await compactProductArchive(db, bucket);
    expect(remaining.published).toBe(false);
  } finally {
    vi.restoreAllMocks();
    sqlite.close();
  }
}, 30000);
it('does not read expired source objects or poison a healthy compaction job behind them', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 32 * 86400000);
    await seed(db, bucket, 32);
    clock.mockRestore();
    const get = vi.fn(bucket.get.bind(bucket));
    expect((await compactProductArchive(db, { put: bucket.put.bind(bucket), get })).published).toBe(
      false,
    );
    expect(get).not.toHaveBeenCalled();
    expect(
      sqlite.prepare('SELECT dirty,error_code FROM product_compaction_jobs').get(),
    ).toMatchObject({ dirty: 0, error_code: null });
  } finally {
    sqlite.close();
  }
}, 30000);
it('retires raw refs atomically before object fencing and preserves held readers through a differently ordered cleanup backlog', async () => {
  const { db, sqlite, bucket } = await fixture();
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 32 * 86400000);
    await seed(db, bucket, 205);
    clock.mockRestore();
    const snapshots = sqlite
      .prepare('SELECT * FROM product_report_segments ORDER BY id')
      .all() as ProductSegment[];
    sqlite.exec(
      'UPDATE product_report_segments SET cleanup_at=0 WHERE id IN(SELECT id FROM product_report_segments ORDER BY id DESC LIMIT 100)',
    );
    const remove = vi.fn(bucket.delete!.bind(bucket));
    const guarded = { put: bucket.put.bind(bucket), get: bucket.get.bind(bucket), delete: remove };
    const now = Date.now();
    expect((await cleanupProductArchive(db, guarded, now)).more).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    for (const row of snapshots)
      expect(await readProductObject(bucket, row, { total: 0, limit: 1048576 })).toHaveLength(1);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches WHERE object_deleted=1').get(),
    ).toMatchObject({ n: 100 });
    for (let i = 0; i < 5; i++) await cleanupProductArchive(db, guarded, now + 3600001);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM product_report_segments WHERE active=1').get(),
    ).toMatchObject({ n: 0 });
    await expect(
      readProductObject(bucket, snapshots[0], { total: 0, limit: 1048576 }),
    ).rejects.toThrow('changed');
  } finally {
    sqlite.close();
  }
}, 30000);

it('rejects publication when a source expires during upload while its compaction lease remains live', async () => {
  const { db, sqlite, bucket } = await fixture();
  const now = Date.now(),
    clock = vi.spyOn(Date, 'now');
  try {
    clock.mockReturnValue(now - 31 * 86400000 + 500);
    await seed(db, bucket, 2);
    clock.mockReturnValue(now);
    const delayed: ProductBucket = {
      get: bucket.get.bind(bucket),
      put: async (...args) => {
        const result = await bucket.put(...args);
        clock.mockReturnValue(now + 1000);
        return result;
      },
    };
    expect((await compactProductArchive(db, delayed)).published).toBe(false);
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM product_report_segments WHERE active=1 AND format=2')
        .get(),
    ).toMatchObject({ n: 0 });
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS n FROM product_report_segments WHERE active=1 AND format=1')
        .get(),
    ).toMatchObject({ n: 2 });
  } finally {
    clock.mockRestore();
    sqlite.close();
  }
}, 30000);
