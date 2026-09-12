import { describe, expect, it } from 'vitest';
import { WINDOW_MS } from '@app-health/contracts';
import {
  AnalyticsEngineBuckets,
  createAnalyticsQuery,
  telemetryScope,
} from '../src/analytics-engine.js';

describe('Analytics Engine telemetry adapter', () => {
  it('aggregates equivalent events and writes only approved dimensions', async () => {
    const points: unknown[] = [];
    const adapter = new AnalyticsEngineBuckets(
      { writeDataPoint: (point) => points.push(point) },
      async () => [],
    );
    await adapter.upsertEvents('app-a', 'env-a', 'node', 'r1', [
      { timestamp: 100, method: 'GET', route: '/users/:id', status_code: 200, duration_ms: 12 },
      { timestamp: 101, method: 'GET', route: '/users/:id', status_code: 503, duration_ms: 20 },
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      blobs: ['GET', '/users/:id', '3', 'node', 'r1', ''],
      doubles: [2, 1, 32, 101],
    });
    expect(JSON.stringify(points[0])).not.toMatch(
      /event_id|header|cookie|body|identity|stack|trace/i,
    );
  });

  it('persists and queries upstream trace-sampling provenance additively', async () => {
    const points: { blobs: string[] }[] = [];
    const writer = new AnalyticsEngineBuckets(
      { writeDataPoint: (point) => points.push(point) },
      async () => [],
    );
    await writer.upsertEvents('app-a', 'env-a', 'otel', undefined, [
      {
        timestamp: 100,
        method: 'GET',
        route: '/otel',
        status_code: 200,
        duration_ms: 10,
        upstream_sampled: true,
      },
    ]);
    expect(points[0].blobs[5]).toBe('sampled');

    const reader = new AnalyticsEngineBuckets({ writeDataPoint: () => undefined }, async () => [
      {
        method: 'GET',
        route: '/otel',
        latency_bucket: 2,
        request_count: 1,
        error_count: 0,
        duration_sum_ms: 10,
        last_seen: 100,
        upstream_sampled: 1,
      },
    ]);
    const buckets = await reader.queryBuckets('app-a', 'env-a', 1000 - WINDOW_MS['15m'], 1000);
    expect(buckets[0].upstream_sampled).toBe(true);
  });

  it('uses fixed sampling-aware SQL and rebuilds a weighted histogram', async () => {
    let sql = '';
    const adapter = new AnalyticsEngineBuckets(
      { writeDataPoint: () => undefined },
      async (query) => {
        sql = query;
        return [
          {
            method: 'GET',
            route: '/health',
            latency_bucket: 2,
            request_count: 20,
            error_count: 1,
            duration_sum_ms: 200,
            last_seen: 500,
            sample_interval: 10,
          },
        ];
      },
    );
    const rows = await adapter.queryBuckets('app-a', 'env-a', 1000 - WINDOW_MS['15m'], 1000);
    expect(rows[0].histogram[2]).toBe(20);
    expect(rows[0].request_count).toBe(20);
    expect(rows[0].sampled).toBe(true);
    expect(sql).toContain('app_health_endpoint_v1');
    expect(sql).toContain('_sample_interval');
    expect(sql).toContain(await telemetryScope('app-a', 'env-a'));
    expect(sql).toContain("blob5 != 'polaris-staging-canary'");
    expect(sql).not.toContain('app-a');
  });

  it('uses explicit half-open query bounds and rejects malformed rows', async () => {
    let sql = '';
    const from = 1_700_000_000_123;
    const to = from + WINDOW_MS['15m'];
    const adapter = new AnalyticsEngineBuckets(
      { writeDataPoint: () => undefined },
      async (query) => {
        sql = query;
        return [
          {
            method: 'GET',
            route: '/health',
            latency_bucket: 2,
            request_count: 1,
            error_count: 0,
            duration_sum_ms: 10,
            last_seen: from,
          },
        ];
      },
    );
    await adapter.queryBuckets('app-a', 'env-a', from, to);
    expect(sql).toContain('timestamp >= toDateTime(1700000000)');
    expect(sql).toContain('timestamp < toDateTime(1700000901)');

    const malformed = new AnalyticsEngineBuckets({ writeDataPoint: () => undefined }, async () => [
      {
        method: 'GET',
        route: '/health',
        latency_bucket: 2,
        request_count: Number.NaN,
        error_count: 0,
        duration_sum_ms: 10,
        last_seen: from,
      },
    ]);
    await expect(malformed.queryBuckets('app-a', 'env-a', from, to)).rejects.toThrow('invalid row');
  });

  it('fails closed on malformed query payloads and supplies a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    const query = createAnalyticsQuery({
      accountId: '0123456789abcdef0123456789abcdef',
      token: 'query-token',
      fetchImpl: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await expect(query('SELECT 1')).rejects.toThrow('invalid data');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('rejects more than 250 expanded points before writing', async () => {
    const points: unknown[] = [];
    const adapter = new AnalyticsEngineBuckets(
      { writeDataPoint: (point) => points.push(point) },
      async () => [],
    );
    const events = Array.from({ length: 251 }, (_, index) => ({
      timestamp: index,
      method: 'GET',
      route: `/route-${index}`,
      status_code: 200,
      duration_ms: 10,
    }));
    await expect(adapter.upsertEvents('app-a', 'env-a', 'node', undefined, events)).rejects.toThrow(
      /250/,
    );
    expect(points).toHaveLength(0);
  });
});
