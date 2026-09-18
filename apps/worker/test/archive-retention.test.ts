import { expect, it, vi } from 'vitest';
import { expireBrowserArchives } from '../src/archive-retention.js';

it('preserves old canonical facts until a verified successor exists', async () => {
  const keys = ['browser-v2/2020/01/01/only-copy.jsonl.gz'];
  const bucket = {
    list: vi.fn(async () => ({ objects: keys.map((key) => ({ key })), truncated: false })),
    delete: vi.fn(async () => {
      keys.length = 0;
    }),
  };
  await expireBrowserArchives(bucket, Date.UTC(2026, 8, 14));
  await expireBrowserArchives(bucket, Date.UTC(2027, 8, 14));
  expect(keys).toEqual(['browser-v2/2020/01/01/only-copy.jsonl.gz']);
  expect(bucket.delete).not.toHaveBeenCalled();
  expect(bucket.list).not.toHaveBeenCalled();
});
