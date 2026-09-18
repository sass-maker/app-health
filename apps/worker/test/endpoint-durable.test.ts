import { readEndpointBuckets } from '../src/endpoint-read.js';
import { AnalyticsEngineBuckets, telemetryScope } from '../src/analytics-engine.js';
import { mergeBuckets } from '@app-health/contracts';
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
  const schema = (
    await Promise.all(
      ['0014_endpoint_rollups.sql', '0015_response_payload_bytes.sql'].map((file) =>
        readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
      ),
    )
  ).join('\n');
  for (const sql of schema
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((sql) => sql.trim()))
    await db.prepare(sql).run();
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

it('combines old AE data with durable counts exactly once and keeps source errors visible', async () => {
  const end = Math.floor(now / 60_000) * 60_000;
  await writer.accept('a', 'prod', 'node', undefined, [event('new', now - 60_000)], {
    now,
    batchId: 'new',
  });
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS app_health_endpoint_v1 (
    index1 TEXT, blob1 TEXT, blob2 TEXT, blob3 TEXT, blob5 TEXT, blob6 TEXT, blob7 TEXT,
    double1 REAL, double2 REAL, double3 REAL, double4 REAL, double5 REAL, double6 REAL,
    _sample_interval INTEGER, timestamp INTEGER
  )`,
    )
    .run();
  const scope = await telemetryScope('a', 'prod');
  for (const tag of ['', 'durable-v1']) {
    await db
      .prepare(
        `INSERT INTO app_health_endpoint_v1 VALUES (?, 'GET', '/users/:id', '2', '', '', ?, 1, 0, 10, ?, 512, 1, 1, ?)`,
      )
      .bind(scope, tag, now - 60_000, Math.floor((now - 60_000) / 1000))
      .run();
  }
  const points: { blobs: string[] }[] = [];
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
