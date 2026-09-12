import { describe, expect, it } from 'vitest';
import {
  areEndpointEquivalent,
  buildCanonicalBatch,
  goBatchFixture,
  healthState,
  nodeBatchFixture,
  workerBatchFixture,
  validateBatch,
  EventBatchV1,
  EventV1,
  SEED_BUCKETS,
  buildSeedBuckets,
  seededAggregateResponse,
  mergeBuckets,
  approximatePercentiles,
  MAX_BATCH_EVENTS,
  MAX_ROUTE_LENGTH,
  MAX_DURATION_MS,
  SCHEMA_VERSION,
  FailureEventV1,
  FailureQueryRequestV1,
  FailureQueryResponseV1,
} from '../src/index.js';

it('preserves literal route separators and storage sampling when merging measurements', () => {
  const bucket = { ...SEED_BUCKETS[0], route: '/a|b', sampled: true };
  const result = mergeBuckets([bucket], '24h', bucket.bucket_start + 1000);
  expect(result[0].route).toBe('/a|b');
  expect(result[0].sampled).toBe(true);
});

it('uses the accepted duration ceiling for an overflow percentile bound', () => {
  const histogram = Array.from({ length: 16 }, (_, index) => (index === 15 ? 20 : 0));
  expect(approximatePercentiles(histogram)).toEqual({
    p50_ms: MAX_DURATION_MS,
    p95_ms: MAX_DURATION_MS,
  });
});

describe('event batch validation', () => {
  it('accepts the canonical Node fixture', () => {
    const result = validateBatch(nodeBatchFixture());
    expect(result.ok).toBe(true);
  });

  it('accepts the canonical Go fixture', () => {
    const result = validateBatch(goBatchFixture());
    expect(result.ok).toBe(true);
  });

  it('accepts the canonical Cloudflare Worker fixture', () => {
    const result = validateBatch(workerBatchFixture());
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown schema version', () => {
    const batch = nodeBatchFixture();
    const result = validateBatch({ ...batch, schema_version: 'v2' });
    expect(result.ok).toBe(false);
  });

  it('requires the SDK runtime', () => {
    const { runtime: _runtime, ...batch } = nodeBatchFixture();
    expect(validateBatch(batch).ok).toBe(false);
  });

  it('rejects unknown batch and event fields instead of stripping them', () => {
    const batch = nodeBatchFixture();
    expect(validateBatch({ ...batch, authorization: 'Bearer secret' }).ok).toBe(false);
    expect(
      validateBatch({
        ...batch,
        events: [{ ...batch.events[0], request_body: { secret: true } }, ...batch.events.slice(1)],
      }).ok,
    ).toBe(false);
  });

  it('rejects an empty batch', () => {
    const batch = nodeBatchFixture();
    const result = validateBatch({ ...batch, events: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects a batch exceeding MAX_BATCH_EVENTS', () => {
    const base = nodeBatchFixture();
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) => ({
      ...base.events[0],
      event_id: `00000000-0000-4000-a000-00000000${i.toString().padStart(8, '0')}`,
      timestamp: base.events[0].timestamp + i,
    }));
    const result = validateBatch({ ...base, events });
    expect(result.ok).toBe(false);
  });

  it('rejects a route that does not start with /', () => {
    const batch = nodeBatchFixture();
    batch.events[0].route = 'users/:id';
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('rejects a route exceeding MAX_ROUTE_LENGTH', () => {
    const batch = nodeBatchFixture();
    batch.events[0].route = '/' + 'a'.repeat(MAX_ROUTE_LENGTH);
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-uuid event_id', () => {
    const batch = nodeBatchFixture();
    batch.events[0].event_id = 'not-a-uuid';
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('rejects an out-of-range status code', () => {
    const batch = nodeBatchFixture();
    batch.events[0].status_code = 99;
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('rejects a negative duration', () => {
    const batch = nodeBatchFixture();
    batch.events[0].duration_ms = -1;
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('rejects a method with non-letter characters', () => {
    const batch = nodeBatchFixture();
    batch.events[0].method = 'G3T';
    const result = validateBatch(batch);
    expect(result.ok).toBe(false);
  });

  it('normalizes a lowercase method to uppercase before validation', () => {
    const batch = nodeBatchFixture();
    batch.events[0].method = 'get';
    const result = validateBatch(batch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.batch.events[0].method).toBe('GET');
  });
});

describe('failure transparency contracts', () => {
  it('accepts only bounded 4xx and 5xx failure rows', () => {
    const failure = {
      failure_id: '00000000-0000-4000-a000-000000000001',
      method: 'GET',
      route: '/users/:id',
      status_code: 404,
      duration_ms: 28,
      occurred_at: 1_725_000_000_000,
      release: '2026.07.22',
    };
    expect(FailureEventV1.parse(failure)).toEqual(failure);
    expect(FailureEventV1.safeParse({ ...failure, status_code: 200 }).success).toBe(false);
    expect(FailureEventV1.safeParse({ ...failure, request_body: 'secret' }).success).toBe(false);
  });

  it('bounds failure queries and validates the retention policy', () => {
    expect(FailureQueryRequestV1.parse({ app_id: 'app-1', environment_id: 'env-1' })).toMatchObject(
      { window: '24h', limit: 50 },
    );
    expect(
      FailureQueryRequestV1.parse({
        app_id: 'app-1',
        environment_id: 'env-1',
        window: '15m',
      }).window,
    ).toBe('15m');
    expect(
      FailureQueryRequestV1.safeParse({ app_id: 'app-1', environment_id: 'env-1', limit: 101 })
        .success,
    ).toBe(false);
    expect(
      FailureQueryRequestV1.safeParse({
        app_id: 'app-1',
        environment_id: 'env-1',
        window: '99m',
      }).success,
    ).toBe(false);
    expect(
      FailureQueryResponseV1.safeParse({
        refreshed_at: 1,
        window: '1h',
        retention_hours: 24,
        limit: 50,
        failures: [],
      }).success,
    ).toBe(true);
  });
});

describe('canonical fixture equivalence', () => {
  it('Node, Cloudflare Worker, and Go fixtures are endpoint-equivalent', () => {
    expect(areEndpointEquivalent(nodeBatchFixture(), goBatchFixture())).toBe(true);
    expect(areEndpointEquivalent(nodeBatchFixture(), workerBatchFixture())).toBe(true);
  });

  it('buildCanonicalBatch produces a parseable batch for each runtime', () => {
    for (const runtime of ['node', 'worker', 'go'] as const) {
      const batch = buildCanonicalBatch(runtime);
      expect(EventBatchV1.safeParse(batch).success).toBe(true);
      expect(batch.runtime).toBe(runtime);
    }
  });

  it('each event in the canonical batch parses individually', () => {
    const batch = nodeBatchFixture();
    for (const event of batch.events) {
      expect(EventV1.safeParse(event).success).toBe(true);
    }
  });
});

describe('health state calculation', () => {
  it('labels low volume as insufficient-data regardless of p95', () => {
    expect(healthState({ request_count: 10, error_rate: 0.5, p95_ms: 5000 })).toBe(
      'insufficient-data',
    );
  });

  it('labels healthy below degraded thresholds', () => {
    expect(healthState({ request_count: 100, error_rate: 0, p95_ms: 100 })).toBe('healthy');
  });

  it('labels degraded at error rate >= 1%', () => {
    expect(healthState({ request_count: 100, error_rate: 0.01, p95_ms: 100 })).toBe('degraded');
  });

  it('labels degraded at p95 >= 1000ms', () => {
    expect(healthState({ request_count: 100, error_rate: 0, p95_ms: 1000 })).toBe('degraded');
  });

  it('labels unhealthy at error rate >= 5%', () => {
    expect(healthState({ request_count: 100, error_rate: 0.05, p95_ms: 100 })).toBe('unhealthy');
  });

  it('labels unhealthy at p95 >= 2000ms', () => {
    expect(healthState({ request_count: 100, error_rate: 0, p95_ms: 2000 })).toBe('unhealthy');
  });
});

describe('seeded endpoint metrics', () => {
  it('exposes a non-empty set of seeded buckets', () => {
    expect(SEED_BUCKETS.length).toBeGreaterThan(0);
  });

  it('produces an aggregate response with deterministic endpoints', () => {
    const response = seededAggregateResponse('15m');
    expect(response.window).toBe('15m');
    expect(response.endpoints.length).toBeGreaterThan(0);
    for (const e of response.endpoints) {
      expect(e.method.length).toBeGreaterThan(0);
      expect(e.route.startsWith('/')).toBe(true);
      expect(e.request_count).toBeGreaterThan(0);
      expect(e.error_rate).toBeGreaterThanOrEqual(0);
      expect(e.error_rate).toBeLessThanOrEqual(1);
    }
  });

  it('approximatePercentiles returns 0 for an empty histogram', () => {
    expect(approximatePercentiles(new Array(16).fill(0))).toEqual({ p50_ms: 0, p95_ms: 0 });
  });

  it('mergeBuckets groups by method and route', () => {
    const merged = mergeBuckets(SEED_BUCKETS, '1h');
    const keys = new Set(merged.map((e) => `${e.method}|${e.route}`));
    expect(keys.size).toBe(merged.length);
    expect(keys.has('GET|/users/:id')).toBe(true);
    expect(keys.has('POST|/orders')).toBe(true);
  });

  it('propagates upstream sampling provenance into endpoint aggregates', () => {
    const bucket = { ...SEED_BUCKETS[0], upstream_sampled: true };
    expect(mergeBuckets([bucket], '1h', bucket.bucket_start)?.[0]?.upstream_sampled).toBe(true);
  });

  it('filters one-minute buckets to the selected window', () => {
    const fifteenMinutes = mergeBuckets(SEED_BUCKETS, '15m');
    const oneHour = mergeBuckets(SEED_BUCKETS, '1h');
    const shortOrders = fifteenMinutes.find((endpoint) => endpoint.route === '/orders');
    const longOrders = oneHour.find((endpoint) => endpoint.route === '/orders');
    expect(shortOrders?.request_count).toBe(5);
    expect(longOrders?.request_count).toBe(10);
  });

  it('places samples exactly on a latency bound in that bound', () => {
    const healthBucket = buildSeedBuckets(1_725_000_000_000).find(
      (bucket) => bucket.route === '/health',
    );
    expect(healthBucket?.histogram[2]).toBe(3);
  });
});

describe('schema version', () => {
  it('exposes the v1 schema version literal', () => {
    expect(SCHEMA_VERSION).toBe('v1');
  });
});
