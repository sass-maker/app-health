import { describe, expect, it, vi } from 'vitest';
import { AppHealthService, InMemoryAdapter } from '../src/index.js';
import {
  SEED_APP_ID,
  SEED_ENV_ID,
  SEED_ENV_NAME,
  SEED_KEY,
  SEED_PUBLIC_KEY,
  SEED_PUBLIC_KEY_ORIGINS,
  defaultLogRoutes,
  type LogEventV1,
} from '@app-health/contracts';

const NOW = 1_800_000_000_000;

function log(id: string, timestamp = NOW, level: LogEventV1['level'] = 'error'): LogEventV1 {
  return {
    log_id: id,
    timestamp,
    event: 'readiness.check',
    level,
    props: {},
  };
}

function batch(logs: LogEventV1[], batchId?: string) {
  return {
    schema_version: 'v1' as const,
    environment: SEED_ENV_NAME,
    ...(batchId ? { batch_id: batchId } : {}),
    logs,
  };
}

function browserBatch(logs: LogEventV1[], batchId: string) {
  return { ...batch(logs, batchId), public_key: SEED_PUBLIC_KEY };
}

describe('log readiness contracts', () => {
  it('deduplicates replayed server and browser batches before sink delivery', async () => {
    const adapter = await InMemoryAdapter.create();
    const service = new AppHealthService(adapter.asRepositories());
    const routes = defaultLogRoutes();
    const serverBody = batch(
      [log('00000000-0000-4000-a000-000000000001')],
      '11111111-2222-4333-a444-000000000001',
    );
    const firstServer = await service.ingestLogs(SEED_KEY, serverBody, NOW, routes);
    const replayServer = await service.ingestLogs(SEED_KEY, serverBody, NOW, routes);
    expect(firstServer).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(replayServer).toMatchObject({ accepted: 0, duplicates: 1, sinks: {} });

    const browserBody = browserBatch(
      [log('00000000-0000-4000-a000-000000000002')],
      '11111111-2222-4333-a444-000000000002',
    );
    const firstBrowser = await service.ingestBrowserLogs(
      browserBody,
      SEED_PUBLIC_KEY_ORIGINS[0],
      NOW,
      routes,
    );
    const replayBrowser = await service.ingestBrowserLogs(
      browserBody,
      SEED_PUBLIC_KEY_ORIGINS[0],
      NOW,
      routes,
    );
    expect(firstBrowser).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(replayBrowser).toMatchObject({ accepted: 0, duplicates: 1, sinks: {} });
  });

  it('rejects out-of-window timestamps before browser quota consumption', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    const consume = vi.spyOn(repos.publicKeys!, 'consumeBrowserQuota');
    const service = new AppHealthService(repos);
    const result = await service.ingestBrowserLogs(
      browserBatch(
        [log('00000000-0000-4000-a000-000000000003', NOW - 30 * 86_400_000 - 1)],
        '11111111-2222-4333-a444-000000000003',
      ),
      SEED_PUBLIC_KEY_ORIGINS[0],
      NOW,
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(consume).not.toHaveBeenCalled();
  });

  it('releases a log claim when persistence fails so a retry can succeed', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    const original = repos.logs!.recordLogs.bind(repos.logs);
    let fail = true;
    repos.logs!.recordLogs = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('storage unavailable');
      }
      return original(...args);
    };
    const service = new AppHealthService(repos);
    const body = batch(
      [log('00000000-0000-4000-a000-000000000004')],
      '11111111-2222-4333-a444-000000000004',
    );
    await expect(service.ingestLogs(SEED_KEY, body, NOW)).rejects.toThrow('storage unavailable');
    await expect(service.ingestLogs(SEED_KEY, body, NOW)).resolves.toMatchObject({
      accepted: 1,
      duplicates: 0,
    });
  });

  it('uses the supplied query clock for retention and future bounds', async () => {
    const adapter = await InMemoryAdapter.create();
    await adapter.recordLogs(
      SEED_APP_ID,
      SEED_ENV_ID,
      [
        log('00000000-0000-4000-a000-000000000005', NOW - 30 * 86_400_000 - 1),
        log('00000000-0000-4000-a000-000000000006', NOW - 1_000),
        log('00000000-0000-4000-a000-000000000007', NOW + 5 * 60_000 + 1),
      ],
      'server',
    );
    const service = new AppHealthService(adapter.asRepositories());
    const response = await service.queryLogs(
      SEED_APP_ID,
      SEED_ENV_ID,
      { level: 'debug', limit: 20 },
      NOW,
    );
    expect(response.logs.map((entry) => entry.log_id)).toEqual([
      '00000000-0000-4000-a000-000000000006',
    ]);
  });
});
