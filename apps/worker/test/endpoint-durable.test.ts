import { readEndpointBuckets } from '../src/endpoint-read.js';
import { AnalyticsEngineBuckets, telemetryScope } from '../src/analytics-engine.js';
import { LEGACY_LATENCY_BUCKET_BOUNDS_MS, mergeBuckets } from '@app-health/contracts';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import type { D1DatabaseLike } from '../src/d1-adapter.js';
import { Miniflare } from 'miniflare';
import { D1EndpointWriter } from '../src/endpoint-durable.js';
import { AppHealthService } from '../src/service.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';

const now = Date.UTC(2026, 8, 14, 12, 0, 30);
const event = (id: string, timestamp = now, status = 200) => ({
  event_id: id,
  timestamp,
  method: 'GET',
  route: '/users/:id',
  status_code: status,
  duration_ms: 10,
});
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
  compatibilityDate: '2026-07-22',
  d1Databases: ['DB'],
  cf: false,
});
let db: Awaited<ReturnType<typeof mf.getD1Database>>;
let writer: D1EndpointWriter;
beforeAll(async () => {
  db = await mf.getD1Database('DB');
  for (const migration of [
    '0014_endpoint_rollups.sql',
    '0015_response_payload_bytes.sql',
    '0045_endpoint_exact_degraded_threshold.sql',
  ]) {
    const schema = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
    for (const sql of schema
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((sql) => sql.trim()))
      await db.prepare(sql).run();
  }
  writer = new D1EndpointWriter(db);
});
beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM endpoint_rollups'),
    db.prepare('DELETE FROM endpoint_receipts'),
  ]);
});
afterAll(() => mf.dispose());
const totals = async () =>
  (
    await db
      .prepare(
        `SELECT resolution_ms, SUM(request_count) AS requests,
  SUM(error_count) AS errors, SUM(duration_sum_ms) AS duration, SUM(h2) AS histogram
  FROM endpoint_rollups GROUP BY resolution_ms ORDER BY resolution_ms`,
      )
      .all()
  ).results;

it('keeps minute/hour/day counters and histograms equal across late arrivals and SDK retries', async () => {
  const rows = [event('a', now - 60_000), event('b', now, 503)];
  expect(
    await writer.accept('app', 'prod', 'node', 'r1', rows, { now: now, batchId: 'batch-a' }),
  ).toHaveLength(2);
  expect(
    await writer.accept('app', 'prod', 'node', 'r1', rows, { now: now, batchId: 'batch-a' }),
  ).toHaveLength(0);
  await writer.accept('app', 'prod', 'node', 'r1', [event('c', now - 120_000)], {
    now: now,
    batchId: 'batch-b',
  });
  expect(await totals()).toEqual(
    [60_000, 3_600_000, 86_400_000].map((resolution_ms) => ({
      resolution_ms,
      requests: 3,
      errors: 1,
      duration: 30,
      histogram: 3,
    })),
  );
  const minutes = (
    await db
      .prepare(
        'SELECT bucket_start FROM endpoint_rollups WHERE resolution_ms = 60000 ORDER BY bucket_start',
      )
      .all()
  ).results;
  expect(minutes.map((row) => row.bucket_start)).toEqual([
    now - 150_000,
    now - 90_000,
    now - 30_000,
  ]);
});

it('deduplicates overlapping and internally repeated OTLP events across exports', async () => {
  await writer.accept('app', 'prod', 'otel', undefined, [event('a'), event('b')], { now: now });
  const accepted = await writer.accept(
    'app',
    'prod',
    'otel',
    undefined,
    [event('b'), event('c'), event('c')],
    { now: now },
  );
  expect(accepted.map((row) => row.event_id)).toEqual(['c']);
  expect((await totals()).map((row) => row.requests)).toEqual([3, 3, 3]);
});

it('isolates project/environment receipts and preserves release/runtime dimensions', async () => {
  for (const [app, env] of [
    ['a', 'prod'],
    ['b', 'prod'],
    ['a', 'staging'],
  ]) {
    expect(
      await writer.accept(app, env, 'node', 'r1', [event('x')], { now: now, batchId: 'same' }),
    ).toHaveLength(1);
  }
  await writer.accept('a', 'prod', 'otel', 'r2', [event('z')], { now: now });
  const rows = (
    await db
      .prepare(
        'SELECT app_id, environment_id, runtime, release FROM endpoint_rollups WHERE resolution_ms = 86400000',
      )
      .all()
  ).results;
  expect(rows).toHaveLength(4);
  expect(rows).toContainEqual({
    app_id: 'a',
    environment_id: 'prod',
    runtime: 'otel',
    release: 'r2',
  });
});

it('rolls back earlier resolutions and receipts when a later statement fails', async () => {
  await db
    .prepare(
      `CREATE TRIGGER reject_daily BEFORE INSERT ON endpoint_rollups
    WHEN NEW.resolution_ms = 86400000 BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END`,
    )
    .run();
  try {
    await expect(
      writer.accept('a', 'prod', 'node', undefined, [event('a')], { now: now, batchId: 'retry' }),
    ).rejects.toThrow();
    expect(await totals()).toEqual([]);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM endpoint_receipts').first('n')).toBe(0);
  } finally {
    await db.prepare('DROP TRIGGER reject_daily').run();
  }
  expect(
    await writer.accept('a', 'prod', 'node', undefined, [event('a')], {
      now: now,
      batchId: 'retry',
    }),
  ).toHaveLength(1);
});

it('does not double count concurrent retries or a lost acknowledgement after commit', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      writer.accept('a', 'prod', 'node', undefined, [event('a')], { now: now, batchId: 'same' }),
    ),
  );
  expect(attempts.reduce((sum, rows) => sum + rows.length, 0)).toBe(1);
  const durableDb: D1DatabaseLike = db;
  const lostAck = new D1EndpointWriter({
    prepare: (sql) => db.prepare(sql),
    batch: async (statements) => {
      await durableDb.batch(statements);
      throw new Error('lost acknowledgement');
    },
  });
  await expect(
    lostAck.accept('a', 'prod', 'node', undefined, [event('b')], { now: now, batchId: 'lost' }),
  ).rejects.toThrow('lost acknowledgement');
  expect(
    await writer.accept('a', 'prod', 'node', undefined, [event('b')], {
      now: now,
      batchId: 'lost',
    }),
  ).toEqual([]);
  expect((await totals()).map((row) => row.requests)).toEqual([2, 2, 2]);
});

it('expires only stale receipts and retains all aggregate history', async () => {
  await writer.accept('a', 'prod', 'node', undefined, [event('a')], {
    now: now - 86_400_001,
    batchId: 'old',
  });
  await writer.accept('a', 'prod', 'node', undefined, [event('b')], {
    now: now,
    batchId: 'recent',
  });
  await writer.cleanupReceipts(now);
  expect(await db.prepare('SELECT COUNT(*) AS n FROM endpoint_receipts').first('n')).toBe(1);
  expect((await totals()).map((row) => row.requests)).toEqual([2, 2, 2]);
});

it('accepts durably when projection fails and bypasses the separate pre-commit dedupe claim', async () => {
  const adapter = await InMemoryAdapter.create();
  const repos = adapter.asRepositories();
  repos.durableEndpoints = writer;
  const projection = vi.fn(async () => {
    throw new Error('AE unavailable');
  });
  repos.buckets.upsertEvents = projection;
  const claim = vi.spyOn(repos.dedupe, 'markSeen');
  const service = new AppHealthService(repos);
  const app = await service.createApp({ name: 'durable', environment: 'prod' }, now);
  const batch = {
    schema_version: 'v1',
    runtime: 'node',
    environment: 'prod',
    batch_id: crypto.randomUUID(),
    events: [event(crypto.randomUUID())],
  };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    expect(await service.ingest(app.key.key, batch, now)).toMatchObject({ ok: true, accepted: 1 });
    expect(await service.ingest(app.key.key, batch, now)).toMatchObject({
      ok: true,
      accepted: 0,
      duplicates: 1,
    });
    expect(projection).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    expect((await totals()).map((row) => row.requests)).toEqual([1, 1, 1]);
  } finally {
    warning.mockRestore();
  }
});

it('reads completed minutes without current/future buckets or other tenant traffic', async () => {
  await writer.accept(
    'a',
    'prod',
    'node',
    'r1',
    [event('past', now - 60_000), event('current'), event('future', now + 60_000)],
    { now, batchId: 'read' },
  );
  await writer.accept('other', 'prod', 'node', 'r1', [event('past', now - 60_000)], {
    now,
    batchId: 'read',
  });
  const end = Math.floor(now / 60_000) * 60_000;
  const rows = await readEndpointBuckets(db, 'a', 'prod', end - 900_000, end);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    request_count: 1,
    error_count: 0,
    duration_sum_ms: 10,
    last_seen: now - 60_000,
  });
  await expect(readEndpointBuckets(db, 'a', 'prod', end - 900_000, now)).rejects.toThrow(
    'minute boundaries',
  );
  await db
    .prepare("UPDATE endpoint_rollups SET histogram_bounds_ms = 'unknown' WHERE app_id = 'a'")
    .run();
  await expect(readEndpointBuckets(db, 'a', 'prod', end - 900_000, end)).rejects.toThrow(
    'histogram schema',
  );
});

it('keeps legacy threshold-straddling latency unknown without losing request counts', async () => {
  const timestamp = now - 60_000;
  const events = Array.from({ length: 20 }, (_, index) => ({
    ...event(`legacy-${index}`, timestamp),
    duration_ms: 1500,
  }));
  await writer.accept('legacy-app', 'prod', 'node', 'r1', events, { now, batchId: 'legacy' });
  await db
    .prepare(
      'UPDATE endpoint_rollups SET histogram_bounds_ms = ?, h9 = 20, h10 = 0 WHERE app_id = ? AND resolution_ms = 60000',
    )
    .bind(JSON.stringify(LEGACY_LATENCY_BUCKET_BOUNDS_MS), 'legacy-app')
    .run();

  const end = Math.floor(now / 60_000) * 60_000;
  const [bucket] = await readEndpointBuckets(db, 'legacy-app', 'prod', end - 900_000, end);
  expect(bucket.histogram[9]).toBe(0);
  expect(bucket.histogram[10]).toBe(20);
  expect(bucket.legacy_ambiguous_latency_count).toBe(20);
  const [aggregate] = mergeBuckets([bucket], '15m', end);
  expect(aggregate.p95_ms).toBe(4000);
  expect(aggregate).toMatchObject({
    request_count: 20,
    error_count: 0,
    health_state: 'insufficient-data',
  });
});

it('classifies exact 1000ms p95 from complete new V2 samples', async () => {
  const timestamp = now - 60_000;
  const events = [
    ...Array.from({ length: 18 }, (_, index) => ({
      ...event(`degraded-below-${index}`, timestamp),
      duration_ms: 999,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      ...event(`degraded-edge-${index}`, timestamp),
      duration_ms: 1000,
    })),
  ];
  await writer.accept('degraded-boundary', 'prod', 'node', 'r1', events, {
    now,
    batchId: 'degraded-boundary',
  });

  const end = Math.floor(now / 60_000) * 60_000;
  const [bucket] = await readEndpointBuckets(db, 'degraded-boundary', 'prod', end - 900_000, end);
  const [aggregate] = mergeBuckets([bucket], '15m', end);
  expect(aggregate).toMatchObject({
    request_count: 20,
    p95_ms: 1000,
    health_state: 'degraded',
  });
});

it('resolves a complete 999ms h8 p95 below the degraded threshold', async () => {
  const timestamp = now - 60_000;
  const events = Array.from({ length: 20 }, (_, index) => ({
    ...event(`below-edge-${index}`, timestamp),
    duration_ms: 999,
  }));
  await writer.accept('below-boundary', 'prod', 'node', 'r1', events, {
    now,
    batchId: 'below-boundary',
  });
  const end = Math.floor(now / 60_000) * 60_000;
  const [bucket] = await readEndpointBuckets(db, 'below-boundary', 'prod', end - 900_000, end);
  const [aggregate] = mergeBuckets([bucket], '15m', end);
  expect(bucket).toMatchObject({
    latency_h8_classified_count: 20,
  });
  expect(aggregate).toMatchObject({ request_count: 20, p95_ms: 999, health_state: 'healthy' });
});

it('keeps h8 ambiguous when any old writer contribution is unclassified', async () => {
  const timestamp = now - 60_000;
  const events = Array.from({ length: 20 }, (_, index) => ({
    ...event(`mixed-${index}`, timestamp),
    duration_ms: 999,
  }));
  await writer.accept('mixed-boundary', 'prod', 'node', 'r1', events, {
    now,
    batchId: 'mixed-boundary',
  });
  await db
    .prepare('UPDATE endpoint_rollups SET h8_classified_count = 18 WHERE app_id = ?')
    .bind('mixed-boundary')
    .run();
  const end = Math.floor(now / 60_000) * 60_000;
  const [bucket] = await readEndpointBuckets(db, 'mixed-boundary', 'prod', end - 900_000, end);
  const [aggregate] = mergeBuckets([bucket], '15m', end);
  expect(aggregate).toMatchObject({
    request_count: 20,
    p95_ms: 1000,
    health_state: 'insufficient-data',
  });
});

it('combines old AE data with durable counts exactly once and keeps source errors visible', async () => {
  const end = Math.floor(now / 60_000) * 60_000;
  await writer.accept('a', 'prod', 'node', undefined, [event('new', now - 60_000)], {
    now,
    batchId: 'new',
  });
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_health_endpoint_v1 (
    index1 TEXT, blob1 TEXT, blob2 TEXT, blob3 TEXT, blob5 TEXT, blob6 TEXT, blob7 TEXT, blob8 TEXT,
    double1 REAL, double2 REAL, double3 REAL, double4 REAL, double5 REAL, double6 REAL,
    double7 REAL, double8 REAL,
    _sample_interval INTEGER, timestamp INTEGER
  )`,
    )
    .run();
  const scope = await telemetryScope('a', 'prod');
  for (const tag of ['', 'durable-v1']) {
    await db
      .prepare(
        `INSERT INTO app_health_endpoint_v1 VALUES (?, 'GET', '/users/:id', '2', '', '', ?, '', 1, 0, 10, ?, NULL, NULL, 0, 0, 1, ?)`,
      )
      .bind(scope, tag, now - 60_000, Math.floor((now - 60_000) / 1000))
      .run();
  }
  const points: { blobs: string[]; doubles: number[] }[] = [];
  const adapter = new AnalyticsEngineBuckets(
    { writeDataPoint: (point) => points.push(point) },
    async (sql) => {
      // Execute generated SQL against SQLite with equivalent provider time/IF syntax.
      return (
        await db.prepare(sql.replace(/toDateTime\((\d+)\)/g, '$1').replaceAll('IF(', 'IIF(')).all<{
          method: string;
          route: string;
          latency_bucket: string;
          request_count: number;
          error_count: number;
          duration_sum_ms: number;
          last_seen: number;
        }>()
      ).results;
    },
    (app, env, from, to) => readEndpointBuckets(db, app, env, from, to),
  );
  await adapter.upsertEvents('a', 'prod', 'node', undefined, [event('new')]);
  expect(points[0].blobs[6]).toBe('durable-v1');
  const buckets = await adapter.queryBuckets('a', 'prod', end - 900_000, end);
  expect(mergeBuckets(buckets, '15m', end)[0]).toMatchObject({
    request_count: 2,
    error_count: 0,
    p95_ms: 10,
  });
  await adapter.upsertEvents('a', 'prod', 'node', undefined, [
    { ...event('edge'), duration_ms: 1000 },
  ]);
  expect(points[1].doubles.slice(6, 8)).toEqual([1, 1]);
  const broken = new AnalyticsEngineBuckets(
    { writeDataPoint() {} },
    async () => {
      throw new Error('legacy unavailable');
    },
    (app, env, from, to) => readEndpointBuckets(db, app, env, from, to),
  );
  await expect(broken.queryBuckets('a', 'prod', end - 900_000, end)).rejects.toThrow(
    'legacy unavailable',
  );
});

it('preserves exact-boundary evidence in Analytics Engine points and reads', async () => {
  const end = Math.floor(now / 60_000) * 60_000;
  const events = [
    ...Array.from({ length: 18 }, (_, index) => ({
      ...event(`ae-below-${index}`, end - 60_000),
      duration_ms: 500,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      ...event(`ae-edge-${index}`, end - 60_000),
      duration_ms: 1000,
    })),
  ];
  const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
  const adapter = new AnalyticsEngineBuckets(
    { writeDataPoint: (point) => points.push(point) },
    async () =>
      points.map((point) => ({
        method: point.blobs[0]!,
        route: point.blobs[1]!,
        latency_bucket: point.blobs[2]!,
        histogram_schema: point.blobs[7]!,
        request_count: point.doubles[0]!,
        error_count: point.doubles[1]!,
        duration_sum_ms: point.doubles[2]!,
        last_seen: point.doubles[3]!,
        response_bytes_sum: point.doubles[4]!,
        response_bytes_measured: point.doubles[5]!,
        h8_classified_count: point.doubles[6]!,
        h8_exact_1000ms_count: point.doubles[7]!,
        sample_interval: 1,
      })),
  );
  await adapter.upsertEvents('ae-app', 'prod', 'node', undefined, events);
  const buckets = await adapter.queryBuckets('ae-app', 'prod', end - 900_000, end);
  expect(buckets[0]).toMatchObject({
    latency_h8_classified_count: 2,
    latency_exact_1000ms_count: 2,
  });
  expect(mergeBuckets(buckets, '15m', end)[0]).toMatchObject({
    request_count: 20,
    p95_ms: 1000,
    health_state: 'degraded',
  });

  const oldWriter = new AnalyticsEngineBuckets({ writeDataPoint() {} }, async () => [
    {
      method: 'GET',
      route: '/users/:id',
      latency_bucket: '8',
      histogram_schema: 'latency-v2',
      request_count: 2,
      error_count: 0,
      duration_sum_ms: 2000,
      last_seen: end - 60_000,
      sample_interval: 1,
    },
  ]);
  expect(
    mergeBuckets(
      await oldWriter.queryBuckets('ae-old-app', 'prod', end - 900_000, end),
      '15m',
      end,
    )[0],
  ).toMatchObject({ p95_ms: 1000, health_state: 'insufficient-data' });
});

it('uses disjoint daily/hourly interiors and minute edges without adding tiers together', async () => {
  const end = Math.floor(now / 60_000) * 60_000;
  const start = end - 2 * 86_400_000 - 17 * 60_000;
  const timestamps = [
    start - 60_000,
    start,
    start + 60_000,
    start + 3_600_000,
    start + 86_400_000,
    end - 3_600_000,
    end - 60_000,
    end,
  ];
  await writer.accept(
    'tiered',
    'prod',
    'node',
    undefined,
    timestamps.map((timestamp, i) => event(String(i), timestamp)),
    { now, batchId: 'tiers' },
  );
  const reads: string[] = [];
  const writerDb: D1DatabaseLike = db;
  const captured: D1DatabaseLike = {
    prepare: (sql) => {
      reads.push(sql);
      return db.prepare(sql);
    },
    batch: (statements) => writerDb.batch(statements),
  };
  const rows = await readEndpointBuckets(captured, 'tiered', 'prod', start, end);
  expect(rows[0].request_count).toBe(6);
  expect(rows[0].histogram[2]).toBe(6);
  expect(reads[0]).toContain('resolution_ms = 86400000');
  expect(reads[0]).toContain('resolution_ms = 3600000');
  expect(reads[0]).toContain('resolution_ms = 60000');
});
