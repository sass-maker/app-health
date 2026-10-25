import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import entry from '../src/analytics-entry.js';
import { analysisDatabase } from './analysis-sqlite.js';
import {
  maintainProductArchive,
  type ProductCleanupWake,
} from '../src/product-event-maintenance.js';
import type { Env } from '../src/index.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const database = analysisDatabase(),
    pending: ProductCleanupWake[] = [];
  const send = vi.fn(async (wake: ProductCleanupWake) => {
    pending.push(wake);
  });
  const remove = vi.fn(async () => {}),
    put = vi.fn(async () => ({})),
    get = vi.fn(async () => null);
  const env = {
    DB: database.db,
    BROWSER_EVENTS: { send },
    BROWSER_HISTORY: { put, get, delete: remove },
  } as unknown as Env;
  const seed = (count: number) =>
    database.sqlite
      .exec(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<${count})
 INSERT INTO product_batches(workspace_id,app_id,environment_id,channel,batch_id,digest,reservation,state,object_key,input_count,input_bytes,min_time,max_time,received_at,expires_at)
 SELECT 'ws','app','env','server','batch-'||v,'${'a'.repeat(64)}','reservation-'||v,'sealed','product-events/v1/expired-'||v,1,1,0,0,0,0 FROM n;`);
  const message = (body: ProductCleanupWake) => ({ body, ack: vi.fn(), retry: vi.fn() });
  const deliver = (messages: ReturnType<typeof message>[]) =>
    entry.queue({ messages } as unknown as MessageBatch<ProductCleanupWake>, env);
  return { ...database, pending, send, remove, put, get, env, seed, message, deliver };
}
it('merges cron+duplicate wakes into one chain, drains100/100/50 and runs at most one slice per batch', async () => {
  const f = fixture();
  try {
    f.seed(250);
    await maintainProductArchive(f.env);
    await maintainProductArchive(f.env);
    expect(f.pending).toHaveLength(1);
    const wake = f.pending.shift()!,
      duplicates = Array.from({ length: 10 }, () => f.message(wake));
    await f.deliver(duplicates);
    for (const msg of duplicates) {
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
    }
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 150,
    });
    expect(f.pending).toHaveLength(1);
    await maintainProductArchive(f.env);
    expect(f.pending).toHaveLength(1);
    await f.deliver([f.message(f.pending.shift()!)]);
    await f.deliver([f.message(f.pending.shift()!)]);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 0,
    });
    expect(f.send).toHaveBeenCalledTimes(3);
  } finally {
    f.sqlite.close();
  }
});
it('restores the consumed wake on failed successor publication and recovers crashed publishers after lease expiry', async () => {
  const f = fixture();
  try {
    f.seed(150);
    await maintainProductArchive(f.env);
    const wake = f.pending.shift()!,
      message = f.message(wake);
    f.send.mockRejectedValueOnce(new Error('unavailable'));
    await f.deliver([message]);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(
      f.sqlite.prepare('SELECT wake_token FROM product_archive_maintenance').get(),
    ).toMatchObject({ wake_token: wake.wake_token });
    await f.deliver([f.message(wake)]);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 0,
    });
    f.sqlite
      .prepare("UPDATE product_archive_maintenance SET wake_token='crashed',wake_until=0")
      .run();
    await maintainProductArchive(f.env);
    expect(f.pending).toHaveLength(1);
  } finally {
    f.sqlite.close();
  }
});
it('upgrades legacy wakes without running a slice and acknowledges browser staging before maintenance I/O', async () => {
  const f = fixture();
  try {
    f.seed(1);
    await f.deliver([f.message({ type: 'product-archive-cleanup', schema_version: 1 })]);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 1,
    });
    expect(f.pending).toHaveLength(1);
    f.sqlite
      .prepare("INSERT INTO product_object_gc VALUES('product-events/v1/fence',0,'fence')")
      .run();
    const browserAck = vi.fn(),
      retry = vi.fn();
    f.put.mockImplementation(async () => {
      expect(browserAck).toHaveBeenCalledOnce();
      return {};
    });
    const browser = {
      workspace: 'ws',
      app_id: 'app',
      environment_id: 'env',
      batch_id: crypto.randomUUID(),
      received_at: Date.now(),
      events: [],
    };
    await entry.queue(
      {
        messages: [f.message(f.pending.shift()!), { body: browser, ack: browserAck, retry }],
      } as unknown as MessageBatch<ProductCleanupWake>,
      {
        ...f.env,
        BROWSER_ARCHIVE: {
          getByName: () => ({ stage: async () => ({ accepted: 1, duplicates: 0 }) }),
        },
      } as unknown as Env,
    );
    expect(f.put).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  } finally {
    f.sqlite.close();
  }
});
