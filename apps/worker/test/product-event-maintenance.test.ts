import { afterEach, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import entry from '../src/analytics-entry.js';
import { analysisDatabase } from './analysis-sqlite.js';
import { maintainProductArchive } from '../src/product-event-maintenance.js';
import type { Env } from '../src/index.js';
afterEach(() => vi.restoreAllMocks());
it('continues indexed maintenance past100receipts through actual queue dispatch without an R2 prefix scan', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    sqlite.exec(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<250)
   INSERT INTO product_batches(workspace_id,app_id,environment_id,channel,batch_id,digest,reservation,state,object_key,input_count,input_bytes,min_time,max_time,received_at,expires_at,cleanup_at)
   SELECT 'ws','app','env','server','batch-'||v,'${'a'.repeat(64)}','reservation-'||v,'sealed','product-events/v1/expired-'||v,1,1,0,0,0,0,0 FROM n;`);
    const remove = vi.fn(async () => {}),
      send = vi.fn(async () => {}),
      put = vi.fn(async () => ({})),
      get = vi.fn(async () => null);
    const env = {
      DB: db,
      BROWSER_EVENTS: { send },
      BROWSER_HISTORY: { put, get, delete: remove },
    } as unknown as Env;
    expect(await maintainProductArchive(env)).toMatchObject({ processed: 100, more: true });
    expect(send).toHaveBeenCalledWith(
      { type: 'product-archive-cleanup', schema_version: 1 },
      { delaySeconds: 1 },
    );
    for (let i = 0; i < 2; i++) {
      const ack = vi.fn(),
        retry = vi.fn();
      await entry.queue(
        {
          messages: [{ body: { type: 'product-archive-cleanup', schema_version: 1 }, ack, retry }],
        } as unknown as MessageBatch<never>,
        env,
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    sqlite.close();
  }
});
it('does not acknowledge maintenance when its durable continuation cannot publish', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    sqlite.exec(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<100)
   INSERT INTO product_object_gc SELECT 'product-events/v1/expired-'||v,0,'delete' FROM n;`);
    const ack = vi.fn(),
      retry = vi.fn();
    await entry.queue(
      {
        messages: [{ body: { type: 'product-archive-cleanup', schema_version: 1 }, ack, retry }],
      } as unknown as MessageBatch<never>,
      {
        DB: db,
        BROWSER_EVENTS: {
          send: async () => {
            throw new Error('unavailable');
          },
        },
        BROWSER_HISTORY: { put: async () => ({}), get: async () => null, delete: async () => {} },
      } as unknown as Env,
    );
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  } finally {
    sqlite.close();
  }
});
