import { describe, expect, it, vi } from 'vitest';
import { browserArchiveShard, consumeBrowserBatches } from '../src/browser-queue.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

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
  it('uses stable scoped shards and projects each new identity only after staging', async () => {
    const first = message();
    const duplicate = message();
    const stage = vi.fn(async (batches: CollectedBrowserBatch[]) => {
      expect(first.ack).not.toHaveBeenCalled();
      return { accepted: [batches[0]], duplicates: 1 };
    });
    const writeDataPoint = vi.fn();
    const getByName = vi.fn(() => ({ stage }));
    await consumeBrowserBatches([first, duplicate], {
      BROWSER_ARCHIVE: { getByName },
      BROWSER_ANALYTICS: { writeDataPoint },
    });
    expect(stage).toHaveBeenCalledWith([first.body, duplicate.body]);
    expect(first.ack).toHaveBeenCalledTimes(1);
    expect(duplicate.ack).toHaveBeenCalledTimes(1);
    expect(writeDataPoint).not.toHaveBeenCalled();
    expect(first.retry).not.toHaveBeenCalled();
    expect(await browserArchiveShard({ ...first.body, received_at: 0 })).toBe(
      await browserArchiveShard(first.body),
    );
    expect(await browserArchiveShard(message('another').body)).not.toBe(
      await browserArchiveShard(first.body),
    );
    stage.mockResolvedValueOnce({ accepted: [], duplicates: 1 });
    await consumeBrowserBatches([message()], {
      BROWSER_ARCHIVE: { getByName },
      BROWSER_ANALYTICS: { writeDataPoint },
    });
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
  it('retries failed groups while acknowledging unrelated work and bounds staging calls', async () => {
    const failed = message('failed');
    const successful = Array.from({ length: 101 }, () => message());
    const stage = vi.fn(async (batches: CollectedBrowserBatch[]) => ({
      accepted: [],
      duplicates: batches.length,
    }));
    const getByName = (name: string) => ({
      stage: name.startsWith('failed:') ? vi.fn().mockRejectedValue(new Error('full')) : stage,
    });
    await consumeBrowserBatches([failed, ...successful], { BROWSER_ARCHIVE: { getByName } });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(stage.mock.calls.map(([batches]) => batches.length)).toEqual([100, 1]);
    expect(successful.every((entry) => vi.mocked(entry.ack).mock.calls.length === 1)).toBe(true);
    const unconfigured = message();
    await consumeBrowserBatches([unconfigured], {});
    expect(unconfigured.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    await consumeBrowserBatches([], {});
  });
});
