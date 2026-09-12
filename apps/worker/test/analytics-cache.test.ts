import { expect, it, vi } from 'vitest';
import { cachedAnalytics } from '../src/analytics-cache.js';

it('reuses authorized workspace reports without mixing accounts, workspaces or filters', async () => {
  const values = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: Request) => values.get(key.url)?.clone()),
    put: vi.fn(async (key: Request, response: Response) => {
      values.set(key.url, response);
    }),
  };
  const load = vi.fn(async () => ({ events: 3 }));
  await cachedAnalytics('account', 'workspace-a', 'today', load, cache);
  expect(await cachedAnalytics('account', 'workspace-a', 'today', load, cache)).toEqual({
    events: 3,
  });
  expect(load).toHaveBeenCalledTimes(1);
  expect(cache.put.mock.calls[0][1].headers.get('cache-control')).toBe('max-age=60');
  await cachedAnalytics('account', 'workspace-b', 'today', load, cache);
  await cachedAnalytics('account-b', 'workspace-a', 'today', load, cache);
  await cachedAnalytics('account', 'workspace-a', 'other-filter', load, cache);
  expect(load).toHaveBeenCalledTimes(4);
});

it('does not cache failures and tolerates unavailable cache storage', async () => {
  const cache = {
    match: vi.fn().mockRejectedValue(new Error('cache unavailable')),
    put: vi.fn().mockRejectedValue(new Error('cache full')),
  };
  const failed = vi.fn().mockRejectedValue(new Error('query unavailable'));
  await expect(cachedAnalytics('a', 'w', 'q', failed, cache)).rejects.toThrow('query unavailable');
  expect(cache.put).not.toHaveBeenCalled();
  expect(await cachedAnalytics('a', 'w', 'q', async () => 4, cache)).toBe(4);
  expect(await cachedAnalytics('a', 'w', 'q', async () => 5)).toBe(5);
});

it('coalesces concurrent misses per cache and releases rejected work', async () => {
  const cache = { match: vi.fn(async () => undefined), put: vi.fn(async () => {}) };
  let release!: (value: number) => void;
  const load = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
  const pending = Promise.all(
    Array.from({ length: 10 }, () => cachedAnalytics('a', 'w', 'q', load, cache)),
  );
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  release(7);
  expect(await pending).toEqual(Array(10).fill(7));

  const failed = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValue(8);
  await expect(cachedAnalytics('a', 'w', 'reject', failed, cache)).rejects.toThrow('failed');
  await expect(cachedAnalytics('a', 'w', 'reject', failed, cache)).resolves.toBe(8);
  expect(failed).toHaveBeenCalledTimes(2);
});
