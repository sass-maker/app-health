import { expect, it, vi } from 'vitest';
import { expireBrowserArchives } from '../src/archive-retention.js';

it('expires old archive partitions, preserves the boundary day and stays within its work budget', async () => {
  const recent = 'browser-v2/2026/09/12/segment.jsonl.gz';
  let keys = [
    ...Array.from({ length: 4500 }, (_, i) => `browser-v2/2026/07/01/${i}.jsonl.gz`),
    'browser-v2/2026/08/13/boundary.jsonl.gz',
    recent,
  ];
  const bucket = {
    list: vi.fn(async () => ({
      objects: keys.slice(0, 1000).map((key) => ({ key })),
      truncated: keys.length > 1000,
    })),
    delete: vi.fn(async (expired: string[]) => {
      const deleting = new Set(expired);
      keys = keys.filter((key) => !deleting.has(key));
    }),
  };
  const now = Date.UTC(2026, 8, 12);
  expect(await expireBrowserArchives(bucket, now)).toEqual({ deleted: 4000, backlog: true });
  expect(bucket.list).toHaveBeenCalledTimes(4);
  expect(await expireBrowserArchives(bucket, now)).toEqual({ deleted: 500, backlog: false });
  expect(keys).toEqual(['browser-v2/2026/08/13/boundary.jsonl.gz', recent]);
  expect(await expireBrowserArchives(bucket, now)).toEqual({ deleted: 0, backlog: false });
});

it('surfaces storage failure without pretending expired data was deleted', async () => {
  await expect(
    expireBrowserArchives({
      list: async () => ({ objects: [{ key: 'browser-v2/2020/01/01/segment' }], truncated: false }),
      delete: async () => {
        throw new Error('storage unavailable');
      },
    }),
  ).rejects.toThrow('storage unavailable');
});
