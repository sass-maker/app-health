import { describe, expect, it, vi } from 'vitest';
import {
  browserArchiveShard,
  consumeBrowserBatches,
  lookupBrowserStagingReceipts,
} from '../src/browser-queue.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';

function receiptDb(
  batch = vi.fn(async (statements: unknown[]) =>
    statements.map(() => ({ success: true, meta: {} })),
  ),
) {
  const db = {
    prepare: vi.fn(() => ({ bind: vi.fn().mockReturnThis() })),
    batch,
  } as unknown as D1DatabaseLike;
  return { db, batch };
}

function message(workspace = 'workspace', batch_id = 'batch'): Message<CollectedBrowserBatch> {
  return {
    id: batch_id,
    timestamp: new Date(),
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
    body: {
      workspace,
      app_id: 'app',
      environment_id: 'prod',
      batch_id,
      received_at: Date.now(),
      events: [
        { event_id: 'event', timestamp: Date.now(), type: 'pageview', path: '/', referrer: '' },
      ],
    },
  };
}
describe('durable browser queue staging', () => {
  it('acks newly accepted and identical duplicate deliveries only after atomic staging', async () => {
    const first = message();
    const duplicate = message();
    const { db, batch } = receiptDb();
    const stage = vi.fn(async (batches: CollectedBrowserBatch[]) => {
      expect(first.ack).not.toHaveBeenCalled();
      expect(batch).not.toHaveBeenCalled();
      return { accepted: [batches[0]], duplicates: 1 };
    });
    const writeDataPoint = vi.fn();
    const getByName = vi.fn(() => ({
      stage,
      lookupStaged: vi.fn().mockResolvedValue({ staged: [], missing: 0 }),
    }));
    await consumeBrowserBatches([first, duplicate], {
      DB: db,
      BROWSER_ARCHIVE: { getByName },
      BROWSER_ANALYTICS: { writeDataPoint },
    });
    expect(stage).toHaveBeenCalledWith([first.body, duplicate.body]);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(duplicate.ack).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).not.toHaveBeenCalled();
    expect(first.retry).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(batch.mock.calls)).not.toContain('visitor_hash');
    expect(await browserArchiveShard({ ...first.body, received_at: 0 })).toBe(
      await browserArchiveShard(first.body),
    );
    expect(await browserArchiveShard(message('another').body)).not.toBe(
      await browserArchiveShard(first.body),
    );
    stage.mockResolvedValueOnce({ accepted: [], duplicates: 1 });
    await consumeBrowserBatches([message()], {
      DB: db,
      BROWSER_ARCHIVE: { getByName },
      BROWSER_ANALYTICS: { writeDataPoint },
    });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
  it('joins bounded D1 identities to the same workspace shards without visitor identifiers', async () => {
    const first = message();
    first.body.visitor_hash = 'raw-visitor-id';
    const second = message('workspace', 'batch-two');
    const lookupStaged = vi.fn(
      async (
        batches: Array<{
          app_id: string;
          environment_id: string;
          batch_id: string;
        }>,
      ) => ({ staged: batches.slice(0, 1), missing: batches.length - 1 }),
    );
    const getByName = vi.fn(() => ({ stage: vi.fn(), lookupStaged }));
    const result = await lookupBrowserStagingReceipts('workspace', [first.body, second.body], {
      BROWSER_ARCHIVE: { getByName },
    });
    const expectedShards = new Set(
      await Promise.all([first.body, second.body].map((entry) => browserArchiveShard(entry))),
    );
    expect(getByName).toHaveBeenCalledTimes(expectedShards.size);
    expect(lookupStaged).toHaveBeenCalledTimes(expectedShards.size);
    expect(result.staged.length + result.missing).toBe(2);
    expect(
      lookupStaged.mock.calls.flatMap(([group]) =>
        group.map((identity) => Object.keys(identity).sort()),
      ),
    ).toEqual([
      ['app_id', 'batch_id', 'environment_id'],
      ['app_id', 'batch_id', 'environment_id'],
    ]);
    expect(JSON.stringify(result)).not.toContain('visitor_hash');
    await expect(
      lookupBrowserStagingReceipts('workspace', Array(1001).fill(first.body), {
        BROWSER_ARCHIVE: { getByName },
      }),
    ).rejects.toThrow('exceeds 1000 batches');
  });
  it('retries failed groups while acknowledging unrelated work and bounds staging calls', async () => {
    const failed = message('failed');
    const successful = Array.from({ length: 101 }, () => message());
    const { db } = receiptDb();
    const stage = vi.fn(async (batches: CollectedBrowserBatch[]) => ({
      accepted: [],
      duplicates: batches.length,
    }));
    const getByName = (name: string) => ({
      stage: name.startsWith('failed:') ? vi.fn().mockRejectedValue(new Error('full')) : stage,
      lookupStaged: vi.fn().mockResolvedValue({ staged: [], missing: 0 }),
    });
    await consumeBrowserBatches([failed, ...successful], {
      DB: db,
      BROWSER_ARCHIVE: { getByName },
    });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(stage.mock.calls.map(([batches]) => batches.length)).toEqual([100, 1]);
    expect(successful.every((entry) => vi.mocked(entry.ack).mock.calls.length === 1)).toBe(true);
    const unconfigured = message();
    await consumeBrowserBatches([unconfigured], {});
    expect(unconfigured.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    await consumeBrowserBatches([], {});
  });

  it('retries after a receipt write failure and safely redelivers already staged messages', async () => {
    const item = message();
    const { db, batch } = receiptDb(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('D1 unavailable'))
        .mockImplementation(async (statements: unknown[]) =>
          statements.map(() => ({ success: true, meta: {} })),
        ),
    );
    const stage = vi.fn(async () => ({ accepted: [item.body], duplicates: 0 }));
    const getByName = vi.fn(() => ({
      stage,
      lookupStaged: vi.fn().mockResolvedValue({ staged: [], missing: 0 }),
    }));
    await consumeBrowserBatches([item], { DB: db, BROWSER_ARCHIVE: { getByName } });
    expect(item.ack).not.toHaveBeenCalled();
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 30 });

    await consumeBrowserBatches([item], { DB: db, BROWSER_ARCHIVE: { getByName } });
    expect(stage).toHaveBeenCalledTimes(2);
    expect(item.ack).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(2);
    const insert = vi.mocked(db.prepare).mock.calls[0]?.[0];
    expect(insert).toContain('ON CONFLICT (workspace_id, app_id, environment_id, batch_id)');
  });
});
