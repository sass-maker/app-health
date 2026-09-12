import { describe, expect, it, vi } from 'vitest';
import { AppHealthService, InMemoryAdapter } from '../src/index.js';
import { hashKey, generateRawKey, KEY_PREFIX } from '../src/crypto.js';
import {
  BUCKET_MS,
  INSUFFICIENT_DATA_MIN_REQUESTS,
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_HISTOGRAM_BUCKETS,
  MAX_CLOCK_SKEW_MS,
  SEED_APP_ID,
  SEED_ENV_ID,
  SEED_KEY,
  buildCanonicalBatch,
  healthState,
  type EventBatchV1,
  type EventV1,
  type Runtime,
} from '@app-health/contracts';

const NOW = 1_725_000_000_000;

function uuid(seed: number): string {
  const hex = (n: number, len: number): string =>
    Math.abs(Math.floor(n * 2654435761))
      .toString(16)
      .padStart(len, '0')
      .slice(-len);
  return (
    `${hex(seed, 8)}-${hex(seed + 1, 4).slice(0, 4)}-4${hex(seed + 2, 3)}` +
    `-a${hex(seed + 3, 3)}-${hex(seed + 4, 8)
      .padStart(12, '0')
      .slice(-12)}`
  );
}

function makeEvent(overrides: Partial<EventV1> & { event_id: string }): EventV1 {
  return {
    timestamp: NOW,
    method: 'GET',
    route: '/test',
    status_code: 200,
    duration_ms: 10,
    ...overrides,
  };
}

function makeBatch(
  events: EventV1[],
  runtime: Runtime = 'node',
  environment?: string,
): EventBatchV1 {
  return {
    batch_id: uuid(9000 + events.length),
    schema_version: 'v1',
    runtime,
    ...(environment ? { environment } : {}),
    release: '0.0.0-test',
    events,
  };
}

async function freshService(): Promise<{ service: AppHealthService; adapter: InMemoryAdapter }> {
  const adapter = await InMemoryAdapter.create();
  const service = new AppHealthService(adapter.asRepositories());
  return { service, adapter };
}

describe('ingest key authentication', () => {
  it('rejects an empty key with 401', async () => {
    const { service } = await freshService();
    const result = await service.ingest('', buildCanonicalBatch('node'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a random non-app-health key with 401', async () => {
    const { service } = await freshService();
    const result = await service.ingest('not-a-real-key', buildCanonicalBatch('node'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('rejects a well-formed but unknown key with 401', async () => {
    const { service } = await freshService();
    const result = await service.ingest(generateRawKey(), buildCanonicalBatch('node'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('accepts the seeded key', async () => {
    const { service } = await freshService();
    const batch = makeBatch([makeEvent({ event_id: uuid(1), timestamp: NOW, route: '/health' })]);
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accepted).toBe(1);
  });

  it('rejects a revoked key with 401', async () => {
    const { service, adapter } = await freshService();
    // Create a new app/key, then revoke it.
    const created = await service.createApp({ name: 'revoke-test', environment: 'prod' }, NOW);
    const rawKey = created.key.key;
    const ingestBatch = makeBatch(
      [makeEvent({ event_id: uuid(2), timestamp: NOW, route: '/r' })],
      'node',
      'prod',
    );
    const before = await service.ingest(rawKey, ingestBatch, NOW);
    expect(before.ok).toBe(true);
    // Revoke the active key for this environment.
    const keyRecord = await adapter
      .asRepositories()
      .keys.getActiveKeyForEnvironment(created.app.id, created.environment.id);
    expect(keyRecord).not.toBeNull();
    await service.revokeKey(keyRecord!.id, NOW);
    const after = await service.ingest(rawKey, ingestBatch, NOW);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.status).toBe(401);
    const status = await service.installationStatus(created.app.id, created.environment.id, NOW);
    expect(status.state).toBe('revoked');
  });

  it('stores only the verifier after returning a one-time key', async () => {
    const { service, adapter } = await freshService();
    const created = await service.createApp({ name: 'key-storage-test', environment: 'prod' }, NOW);
    const record = await adapter
      .asRepositories()
      .keys.getActiveKeyForEnvironment(created.app.id, created.environment.id);
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty('rawKey');
    expect(record?.verifier_hash).not.toBe(created.key.key);
    expect(created.key.environment_id).toBeNull();
  });

  it('requires an environment for product keys and rejects conflicts for legacy keys', async () => {
    const { service } = await freshService();
    const created = await service.createApp({ name: 'product-key', environment: 'prod' }, NOW);
    const event = makeEvent({ event_id: uuid(200), route: '/scope' });
    await expect(service.ingest(created.key.key, makeBatch([event]), NOW)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(
      service.ingest(SEED_KEY, makeBatch([event], 'node', 'staging'), NOW),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });
});

describe('ingest unsafe and unknown fields', () => {
  it('rejects an unknown batch-level field instead of stripping it', async () => {
    const { service } = await freshService();
    const batch = buildCanonicalBatch('node');
    const result = await service.ingest(
      SEED_KEY,
      { ...batch, authorization: 'Bearer secret' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects an unknown event-level field that could carry request content', async () => {
    const { service } = await freshService();
    const batch = buildCanonicalBatch('node');
    const poisoned = {
      ...batch,
      events: [{ ...batch.events[0], request_body: { secret: true } }, ...batch.events.slice(1)],
    };
    const result = await service.ingest(SEED_KEY, poisoned, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects an event with a header-like field', async () => {
    const { service } = await freshService();
    const batch = buildCanonicalBatch('node');
    const poisoned = {
      ...batch,
      events: [
        { ...batch.events[0], headers: { cookie: 'session=abc' } },
        ...batch.events.slice(1),
      ],
    };
    const result = await service.ingest(SEED_KEY, poisoned, NOW);
    expect(result.ok).toBe(false);
  });

  it('rejects a batch with the wrong schema version', async () => {
    const { service } = await freshService();
    const batch = { ...buildCanonicalBatch('node'), schema_version: 'v2' };
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects a batch with an out-of-range status code', async () => {
    const { service } = await freshService();
    const batch = makeBatch([makeEvent({ event_id: uuid(3), status_code: 99 })]);
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(false);
  });
});

describe('ingest clock skew', () => {
  it('rejects an event timestamp too far in the future', async () => {
    const { service } = await freshService();
    const batch = makeBatch([
      makeEvent({ event_id: uuid(4), timestamp: NOW + MAX_CLOCK_SKEW_MS + 1 }),
    ]);
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('rejects an event timestamp too far in the past', async () => {
    const { service } = await freshService();
    const batch = makeBatch([
      makeEvent({ event_id: uuid(5), timestamp: NOW - MAX_CLOCK_SKEW_MS - 1 }),
    ]);
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(false);
  });

  it('accepts an event timestamp within the skew window', async () => {
    const { service } = await freshService();
    const batch = makeBatch([makeEvent({ event_id: uuid(6), timestamp: NOW + MAX_CLOCK_SKEW_MS })]);
    const result = await service.ingest(SEED_KEY, batch, NOW);
    expect(result.ok).toBe(true);
  });
});

describe('ingest idempotent batch handling', () => {
  it('derives a retry-stable batch ID for legacy SDK payloads', async () => {
    const { service } = await freshService();
    const current = makeBatch([makeEvent({ event_id: uuid(9), route: '/legacy' })]);
    const { batch_id: _batchID, ...legacy } = current;
    const first = await service.ingest(SEED_KEY, legacy, NOW);
    const retry = await service.ingest(SEED_KEY, legacy, NOW);
    expect(first).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
    expect(retry).toMatchObject({ ok: true, accepted: 0, duplicates: 1 });
  });

  it('counts a retried batch ID only once', async () => {
    const { service } = await freshService();
    const event = makeEvent({ event_id: uuid(10), timestamp: NOW, route: '/dup' });
    const batch = makeBatch([event]);
    const first = await service.ingest(SEED_KEY, batch, NOW);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.accepted).toBe(1);
      expect(first.duplicates).toBe(0);
    }
    const second = await service.ingest(SEED_KEY, batch, NOW);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.accepted).toBe(0);
      expect(second.duplicates).toBe(1);
    }
    // Query the endpoint and confirm the count is 1, not 2.
    const response = await service.queryEndpoints(SEED_APP_ID, SEED_ENV_ID, '15m', NOW);
    const endpoint = response.endpoints.find((e) => e.route === '/dup');
    expect(endpoint).toBeDefined();
    expect(endpoint!.request_count).toBe(1);
  });

  it('accepts repeated event IDs when they belong to distinct batches', async () => {
    const { service } = await freshService();
    const eventA = makeEvent({ event_id: uuid(20), timestamp: NOW, route: '/mix' });
    await service.ingest(SEED_KEY, makeBatch([eventA]), NOW);
    const eventB = makeEvent({ event_id: uuid(21), timestamp: NOW, route: '/mix' });
    const result = await service.ingest(SEED_KEY, makeBatch([eventA, eventB]), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accepted).toBe(2);
      expect(result.duplicates).toBe(0);
    }
  });

  it('scopes identical batch IDs to their app and environment', async () => {
    const { service } = await freshService();
    const first = await service.createApp({ name: 'dedupe-a', environment: 'prod' }, NOW);
    const second = await service.createApp({ name: 'dedupe-b', environment: 'prod' }, NOW);
    const sharedEvent = makeEvent({ event_id: uuid(22), timestamp: NOW, route: '/shared-id' });
    const firstResult = await service.ingest(
      first.key.key,
      makeBatch([sharedEvent], 'node', 'prod'),
      NOW,
    );
    const secondResult = await service.ingest(
      second.key.key,
      makeBatch([sharedEvent], 'node', 'prod'),
      NOW,
    );
    expect(firstResult).toMatchObject({ ok: true, accepted: 1 });
    expect(secondResult).toMatchObject({ ok: true, accepted: 1 });
  });

  it('releases the dedupe claim when aggregate persistence fails', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    const buckets = repos.buckets;
    let failOnce = true;
    repos.buckets = {
      async upsertBucket(input) {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated aggregate failure');
        }
        await buckets.upsertBucket(input);
      },
      queryBuckets: (appId, envId, from, to) => buckets.queryBuckets(appId, envId, from, to),
    };
    const service = new AppHealthService(repos);
    const event = makeEvent({ event_id: uuid(23), timestamp: NOW, route: '/retry-after-failure' });
    await expect(service.ingest(SEED_KEY, makeBatch([event]), NOW)).rejects.toThrow(
      'simulated aggregate failure',
    );
    const retry = await service.ingest(SEED_KEY, makeBatch([event]), NOW);
    expect(retry).toMatchObject({ ok: true, accepted: 1, duplicates: 0 });
  });

  it('completes control writes before aggregate projection', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    const buckets = repos.buckets;
    const capabilities = repos.capabilities;
    let failOnce = true;
    repos.capabilities = {
      getCapabilities: (...args) => capabilities!.getCapabilities(...args),
      setCapabilities: (...args) => capabilities!.setCapabilities(...args),
      async recordCapability(...args) {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated control failure');
        }
        await capabilities?.recordCapability(...args);
      },
    };
    const upsertEvents = vi.spyOn(buckets, 'upsertEvents');
    const service = new AppHealthService(repos);
    const event = makeEvent({ event_id: uuid(24), timestamp: NOW, route: '/control-first' });
    await expect(service.ingest(SEED_KEY, makeBatch([event]), NOW)).rejects.toThrow(
      'simulated control failure',
    );
    expect(upsertEvents).not.toHaveBeenCalled();
    await expect(service.ingest(SEED_KEY, makeBatch([event]), NOW)).resolves.toMatchObject({
      accepted: 1,
      duplicates: 0,
    });
    expect(upsertEvents).toHaveBeenCalledTimes(1);
  });
});

describe('ingest aggregate-only storage', () => {
  it('does not persist raw event content; only bucket counts change', async () => {
    const { service, adapter } = await freshService();
    const event = makeEvent({
      event_id: uuid(30),
      timestamp: NOW,
      route: '/no-raw',
      method: 'POST',
      status_code: 201,
      duration_ms: 42,
    });
    await service.ingest(SEED_KEY, makeBatch([event]), NOW);
    const buckets = await adapter
      .asRepositories()
      .buckets.queryBuckets(SEED_APP_ID, SEED_ENV_ID, NOW - 60_000, NOW + 60_000);
    const bucket = buckets.find((b) => b.route === '/no-raw');
    expect(bucket).toBeDefined();
    expect(bucket!.request_count).toBe(1);
    expect(bucket!.error_count).toBe(0);
    expect(bucket!.duration_sum_ms).toBe(42);
    // No raw event fields are stored on the bucket.
    expect((bucket as unknown as Record<string, unknown>).event_id).toBeUndefined();
    expect((bucket as unknown as Record<string, unknown>).status_code).toBeUndefined();
  });

  it('keeps a sampled-out endpoint visible without inventing metrics', async () => {
    const { service, adapter } = await freshService();
    const created = await service.createApp({ name: 'sampled-app', environment: 'prod' }, NOW);
    await service.ingest(
      created.key.key,
      makeBatch(
        [
          makeEvent({
            event_id: uuid(31),
            timestamp: NOW,
            route: '/rare/:id',
            method: 'PATCH',
          }),
        ],
        'node',
        'prod',
      ),
      NOW,
    );
    adapter.asRepositories().buckets.queryBuckets = async () => [];

    const response = await service.queryEndpoints(
      created.app.id,
      created.environment.id,
      '15m',
      NOW,
    );
    expect(response.endpoints).toEqual([
      expect.objectContaining({
        method: 'PATCH',
        route: '/rare/:id',
        last_seen: NOW,
        health_state: 'insufficient-data',
        metrics_available: false,
      }),
    ]);
  });

  it('returns every retained 4xx and 5xx field while successes remain aggregate-only', async () => {
    const { service } = await freshService();
    const events = [
      makeEvent({ event_id: uuid(32), status_code: 204, route: '/orders/:id' }),
      makeEvent({
        event_id: uuid(33),
        timestamp: NOW - 1,
        status_code: 404,
        route: '/orders/:id',
        duration_ms: 71,
      }),
      makeEvent({ event_id: uuid(34), status_code: 503, route: '/checkout', duration_ms: 812 }),
    ];
    await service.ingest(SEED_KEY, makeBatch(events), NOW);

    const response = await service.queryFailures(SEED_APP_ID, SEED_ENV_ID, '24h', 50, NOW);
    expect(response).toMatchObject({ window: '24h', retention_hours: 24, limit: 50 });
    expect(response.failures.map((failure) => failure.status_code)).toEqual([503, 404]);
    expect(response.failures[0]).toEqual({
      failure_id: uuid(34),
      method: 'GET',
      route: '/checkout',
      status_code: 503,
      duration_ms: 812,
      occurred_at: NOW,
      release: null,
    });
    expect(JSON.stringify(response)).not.toMatch(/headers|query|body|identity|cookie/);
  });

  it('isolates retained failures by app and environment', async () => {
    const { service } = await freshService();
    const other = await service.createApp({ name: 'other', environment: 'staging' }, NOW);
    await service.ingest(
      other.key.key,
      makeBatch(
        [makeEvent({ event_id: uuid(35), status_code: 500, route: '/private' })],
        'node',
        'staging',
      ),
      NOW,
    );

    const seed = await service.queryFailures(SEED_APP_ID, SEED_ENV_ID, '24h', 50, NOW);
    expect(seed.failures.some((failure) => failure.route === '/private')).toBe(false);
    const scoped = await service.queryFailures(other.app.id, other.environment.id, '24h', 50, NOW);
    expect(scoped.failures.map((failure) => failure.route)).toEqual(['/private']);
  });

  it('filters retained failures to the selected supported window', async () => {
    const { service, adapter } = await freshService();
    await adapter.recordFailures(SEED_APP_ID, SEED_ENV_ID, [
      makeEvent({ event_id: uuid(36), timestamp: NOW - 2 * 60 * 60 * 1000, status_code: 401 }),
      makeEvent({ event_id: uuid(37), timestamp: NOW - 30 * 60 * 1000, status_code: 404 }),
      makeEvent({ event_id: uuid(38), timestamp: NOW - 5 * 60 * 1000, status_code: 503 }),
    ]);

    const recent = await service.queryFailures(SEED_APP_ID, SEED_ENV_ID, '15m', 50, NOW);
    const hourly = await service.queryFailures(SEED_APP_ID, SEED_ENV_ID, '1h', 50, NOW);
    const daily = await service.queryFailures(SEED_APP_ID, SEED_ENV_ID, '24h', 50, NOW);

    expect(recent.failures.map((failure) => failure.status_code)).toEqual([503]);
    expect(hourly.failures.map((failure) => failure.status_code)).toEqual([503, 404]);
    expect(daily.failures.map((failure) => failure.status_code)).toEqual([503, 404, 401]);
  });
});

describe('fixed latency histograms and window merging', () => {
  it('places a duration exactly on a bound into that bound bucket', async () => {
    const { service, adapter } = await freshService();
    // 10ms is exactly LATENCY_BUCKET_BOUNDS_MS[2] (index 2).
    const event = makeEvent({
      event_id: uuid(40),
      timestamp: NOW,
      route: '/bound',
      duration_ms: LATENCY_BUCKET_BOUNDS_MS[2],
    });
    await service.ingest(SEED_KEY, makeBatch([event]), NOW);
    const buckets = await adapter
      .asRepositories()
      .buckets.queryBuckets(SEED_APP_ID, SEED_ENV_ID, NOW - 60_000, NOW + 60_000);
    const bucket = buckets.find((b) => b.route === '/bound');
    expect(bucket).toBeDefined();
    expect(bucket!.histogram[2]).toBe(1);
    // All other buckets are zero.
    const sum = bucket!.histogram.reduce((a, b) => a + b, 0);
    expect(sum).toBe(1);
  });

  it('merges histograms across one-minute buckets for the selected window', async () => {
    const { service } = await freshService();
    // Send 3 events at 10ms in 3 different one-minute buckets.
    const t0 = NOW - 2 * BUCKET_MS;
    const events: EventV1[] = [
      makeEvent({ event_id: uuid(50), timestamp: t0, route: '/merge', duration_ms: 10 }),
      makeEvent({
        event_id: uuid(51),
        timestamp: t0 + BUCKET_MS,
        route: '/merge',
        duration_ms: 10,
      }),
      makeEvent({ event_id: uuid(52), timestamp: NOW, route: '/merge', duration_ms: 10 }),
    ];
    await service.ingest(SEED_KEY, makeBatch(events), NOW);
    const response = await service.queryEndpoints(SEED_APP_ID, SEED_ENV_ID, '15m', NOW);
    const endpoint = response.endpoints.find((e) => e.route === '/merge');
    expect(endpoint).toBeDefined();
    expect(endpoint!.request_count).toBe(3);
    // p50/p95 derived from merged histogram, not averaged per bucket.
    // 3 samples at 10ms -> p50 and p95 both at bound index 2 (10ms).
    expect(endpoint!.p50_ms).toBe(LATENCY_BUCKET_BOUNDS_MS[2]);
    expect(endpoint!.p95_ms).toBe(LATENCY_BUCKET_BOUNDS_MS[2]);
  });

  it('derives p95 from merged histogram counts rather than averaging bucket percentiles', async () => {
    const { service } = await freshService();
    // Bucket 1: 10 samples at 10ms. Bucket 2: 10 samples at 2000ms.
    // Merged p95 should be 2000ms (the 19th of 20 samples), not an average.
    const t0 = NOW - BUCKET_MS;
    const fastEvents: EventV1[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent({
        event_id: uuid(100 + i),
        timestamp: t0,
        route: '/p95',
        duration_ms: 10,
      }),
    );
    const slowEvents: EventV1[] = Array.from({ length: 10 }, (_, i) =>
      makeEvent({
        event_id: uuid(200 + i),
        timestamp: NOW,
        route: '/p95',
        duration_ms: 2000,
      }),
    );
    await service.ingest(SEED_KEY, makeBatch([...fastEvents, ...slowEvents]), NOW);
    const response = await service.queryEndpoints(SEED_APP_ID, SEED_ENV_ID, '15m', NOW);
    const endpoint = response.endpoints.find((e) => e.route === '/p95');
    expect(endpoint).toBeDefined();
    expect(endpoint!.request_count).toBe(20);
    // 2000ms is bound index 9. p95 of 20 samples = ceil(20*0.95)=19th sample,
    // which falls in the 2000ms bucket.
    expect(endpoint!.p95_ms).toBe(LATENCY_BUCKET_BOUNDS_MS[9]);
  });
});

describe('health state threshold edges', () => {
  it('labels 19 requests as insufficient-data', async () => {
    expect(
      healthState({ request_count: INSUFFICIENT_DATA_MIN_REQUESTS - 1, error_rate: 0, p95_ms: 10 }),
    ).toBe('insufficient-data');
  });

  it('labels 20 requests healthy below degraded thresholds', async () => {
    expect(
      healthState({ request_count: INSUFFICIENT_DATA_MIN_REQUESTS, error_rate: 0, p95_ms: 999 }),
    ).toBe('healthy');
  });

  it('labels degraded at exactly p95 1000ms', async () => {
    expect(
      healthState({ request_count: INSUFFICIENT_DATA_MIN_REQUESTS, error_rate: 0, p95_ms: 1000 }),
    ).toBe('degraded');
  });

  it('labels degraded at exactly error rate 1%', async () => {
    expect(healthState({ request_count: 100, error_rate: 0.01, p95_ms: 100 })).toBe('degraded');
  });

  it('labels unhealthy at exactly p95 2000ms', async () => {
    expect(healthState({ request_count: 100, error_rate: 0, p95_ms: 2000 })).toBe('unhealthy');
  });

  it('labels unhealthy at exactly error rate 5%', async () => {
    expect(healthState({ request_count: 100, error_rate: 0.05, p95_ms: 100 })).toBe('unhealthy');
  });

  it('reflects threshold edges through the query API', async () => {
    const { service } = await freshService();
    // 20 requests, 1 error (5% error rate) -> unhealthy.
    const events: EventV1[] = Array.from({ length: 20 }, (_, i) =>
      makeEvent({
        event_id: uuid(300 + i),
        timestamp: NOW,
        route: '/edge',
        status_code: i === 0 ? 500 : 200,
        duration_ms: 10,
      }),
    );
    await service.ingest(SEED_KEY, makeBatch(events), NOW);
    const response = await service.queryEndpoints(SEED_APP_ID, SEED_ENV_ID, '15m', NOW);
    const endpoint = response.endpoints.find((e) => e.route === '/edge');
    expect(endpoint).toBeDefined();
    expect(endpoint!.request_count).toBe(20);
    expect(endpoint!.error_count).toBe(1);
    expect(endpoint!.error_rate).toBeCloseTo(0.05, 10);
    expect(endpoint!.health_state).toBe('unhealthy');
  });
});

describe('project and environment isolation', () => {
  it('ingest into one environment does not appear in another', async () => {
    const { service } = await freshService();
    // Create a second app+environment.
    const other = await service.createApp({ name: 'isolated-app', environment: 'prod' }, NOW);
    const otherKey = other.key.key;
    // Ingest into the other environment.
    const events: EventV1[] = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        event_id: uuid(400 + i),
        timestamp: NOW,
        route: '/isolated',
      }),
    );
    await service.ingest(otherKey, makeBatch(events, 'node', 'prod'), NOW);
    // Query the seed environment: should not see /isolated.
    const seedResponse = await service.queryEndpoints(SEED_APP_ID, SEED_ENV_ID, '15m', NOW);
    expect(seedResponse.endpoints.find((e) => e.route === '/isolated')).toBeUndefined();
    // Query the other environment: should see /isolated.
    const otherResponse = await service.queryEndpoints(
      other.app.id,
      other.environment.id,
      '15m',
      NOW,
    );
    const found = otherResponse.endpoints.find((e) => e.route === '/isolated');
    expect(found).toBeDefined();
    expect(found!.request_count).toBe(5);
  });

  it('querying with a foreign app_id returns no metrics for another app', async () => {
    const { service } = await freshService();
    const other = await service.createApp({ name: 'cross-app', environment: 'prod' }, NOW);
    await service.ingest(
      other.key.key,
      makeBatch(
        [makeEvent({ event_id: uuid(410), timestamp: NOW, route: '/secret' })],
        'node',
        'prod',
      ),
      NOW,
    );
    // Query with the seed app_id but the other environment_id.
    const response = await service.queryEndpoints(SEED_APP_ID, other.environment.id, '15m', NOW);
    expect(response.endpoints.find((e) => e.route === '/secret')).toBeUndefined();
  });

  it('installation status reflects per-environment state', async () => {
    const { service } = await freshService();
    const other = await service.createApp({ name: 'status-app', environment: 'prod' }, NOW);
    // Before ingest: waiting.
    const before = await service.installationStatus(other.app.id, other.environment.id, NOW);
    expect(before.state).toBe('waiting');
    // After ingest: connected.
    await service.ingest(
      other.key.key,
      makeBatch([makeEvent({ event_id: uuid(420), timestamp: NOW, route: '/s' })], 'node', 'prod'),
      NOW,
    );
    const after = await service.installationStatus(other.app.id, other.environment.id, NOW);
    expect(after.state).toBe('connected');
    expect(after.runtime).toBe('node');
  });

  it('isolates local and staging behind one product key', async () => {
    const { service } = await freshService();
    const product = await service.createApp({ name: 'polaris', environment: 'local' }, NOW);
    await service.ingest(
      product.key.key,
      makeBatch([makeEvent({ event_id: uuid(430), route: '/health' })], 'node', 'local'),
      NOW,
    );
    await service.ingest(
      product.key.key,
      makeBatch([makeEvent({ event_id: uuid(431), route: '/health' })], 'node', 'staging'),
      NOW,
    );

    const listed = await service.listApps();
    const environments = listed.apps.find((entry) => entry.app.id === product.app.id)?.environments;
    expect(environments?.map((environment) => environment.name).sort()).toEqual([
      'local',
      'staging',
    ]);
    const staging = environments?.find((environment) => environment.name === 'staging');
    expect(staging).toBeDefined();
    const localEndpoints = await service.queryEndpoints(
      product.app.id,
      product.environment.id,
      '15m',
      NOW,
    );
    const stagingEndpoints = await service.queryEndpoints(product.app.id, staging!.id, '15m', NOW);
    expect(localEndpoints.endpoints[0]?.request_count).toBe(1);
    expect(stagingEndpoints.endpoints[0]?.request_count).toBe(1);
  });
});

describe('empty traffic', () => {
  it('returns an empty endpoint list for an environment with no traffic', async () => {
    const { service } = await freshService();
    const other = await service.createApp({ name: 'empty-app', environment: 'prod' }, NOW);
    const response = await service.queryEndpoints(other.app.id, other.environment.id, '15m', NOW);
    expect(response.endpoints).toEqual([]);
  });

  it('returns waiting installation status for an environment with no traffic', async () => {
    const { service } = await freshService();
    const other = await service.createApp({ name: 'empty-status-app', environment: 'prod' }, NOW);
    const status = await service.installationStatus(other.app.id, other.environment.id, NOW);
    expect(status.state).toBe('waiting');
    expect(status.first_seen).toBeNull();
    expect(status.last_seen).toBeNull();
  });
});

describe('key verifier properties', () => {
  it('generated keys use the ahk_ prefix and are hex', async () => {
    const key = generateRawKey();
    expect(key.startsWith(KEY_PREFIX)).toBe(true);
    const body = key.slice(KEY_PREFIX.length);
    expect(body).toMatch(/^[0-9a-f]+$/);
  });

  it('hashKey produces a non-reversible SHA-256 hex digest', async () => {
    const verifier = await hashKey(SEED_KEY);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    // The verifier does not contain the raw key.
    expect(verifier).not.toContain(SEED_KEY);
  });

  it('different keys produce different verifiers', async () => {
    const a = await hashKey('ahk_aaa');
    const b = await hashKey('ahk_bbb');
    expect(a).not.toBe(b);
  });
});

describe('histogram bucket count invariant', () => {
  it('every bucket has exactly LATENCY_HISTOGRAM_BUCKETS histogram entries', async () => {
    const { service, adapter } = await freshService();
    await service.ingest(
      SEED_KEY,
      makeBatch([makeEvent({ event_id: uuid(500), timestamp: NOW, route: '/h' })]),
      NOW,
    );
    const buckets = await adapter
      .asRepositories()
      .buckets.queryBuckets(SEED_APP_ID, SEED_ENV_ID, NOW - 60_000, NOW + 60_000);
    for (const b of buckets) {
      expect(b.histogram.length).toBe(LATENCY_HISTOGRAM_BUCKETS);
    }
  });
});
