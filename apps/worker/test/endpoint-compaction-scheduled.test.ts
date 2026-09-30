import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { compactEndpointRollupPartition } from '../src/endpoint-compaction.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

vi.mock('../src/endpoint-compaction.js', async (original) => ({
  ...(await original<typeof import('../src/endpoint-compaction.js')>()),
  compactEndpointRollupPartition: vi.fn(),
}));

function bindings() {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  };
  const DB: D1DatabaseLike = {
    prepare: () => statement,
    batch: async () => [],
  };
  const ENDPOINT_HISTORY = {
    get: vi.fn(),
    put: vi.fn(),
  } as unknown as Pick<R2Bucket, 'get' | 'put'>;
  return { DB, ENDPOINT_HISTORY, ENDPOINT_COMPACTION_ENABLED: 'enabled' };
}

afterEach(() => vi.restoreAllMocks());

it('stays inactive without explicit activation', async () => {
  vi.mocked(compactEndpointRollupPartition).mockReset();
  const env = bindings();
  await worker.scheduled(undefined, { ...env, ENDPOINT_COMPACTION_ENABLED: undefined });
  expect(compactEndpointRollupPartition).not.toHaveBeenCalled();
});

it('caps useful work at 32 retired partitions and passes the remaining time budget', async () => {
  const compact = vi.mocked(compactEndpointRollupPartition).mockReset();
  compact.mockResolvedValue({ state: 'retired', rows: 4 });
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  await worker.scheduled(undefined, bindings());
  expect(compact).toHaveBeenCalledTimes(32);
  for (const [args] of compact.mock.calls) {
    expect(args.maxRuntimeMs).toBeGreaterThan(0);
    expect(args.maxRuntimeMs).toBeLessThanOrEqual(10_000);
  }
  expect(info).toHaveBeenCalledWith(
    JSON.stringify({ event: 'endpoint_compaction', state: 'bounded', partitions: 32, rows: 128 }),
  );
});

it('stops when idle and does not start another partition after the shared deadline', async () => {
  const compact = vi.mocked(compactEndpointRollupPartition).mockReset();
  compact.mockResolvedValue({ state: 'idle', rows: 0 });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  await worker.scheduled(undefined, bindings());
  expect(compact).toHaveBeenCalledTimes(1);
  compact.mockClear();
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);
  await worker.scheduled(undefined, bindings());
  expect(compact).not.toHaveBeenCalled();
});
