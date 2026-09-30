import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { compactEndpointRollupPartition } from '../src/endpoint-compaction.js';
import { D1EndpointWriter } from '../src/endpoint-durable.js';
import { readEndpointBuckets } from '../src/endpoint-read.js';

it('preserves historical endpoint reads through minute and hour retirement on real workerd D1 and R2', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    compatibilityDate: '2026-07-22',
    d1Databases: ['DB'],
    r2Buckets: ['HISTORY'],
    cf: false,
  });
  try {
    const db = await mf.getD1Database('DB');
    const runtimeBucket = await mf.getR2Bucket('HISTORY');
    const bucket = runtimeBucket as unknown as Pick<R2Bucket, 'get' | 'put'>;
    await db
      .prepare('CREATE TABLE environments (id TEXT, app_id TEXT, PRIMARY KEY(id,app_id))')
      .run();
    await db.prepare("INSERT INTO environments VALUES ('prod','runtime-app')").run();
    for (const migration of [
      '0014_endpoint_rollups.sql',
      '0015_response_payload_bytes.sql',
      '0027_endpoint_cold_archives.sql',
    ]) {
      const schema = await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8');
      for (const sql of schema
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((sql) => sql.trim()))
        await db.prepare(sql).run();
    }
    const day = Date.UTC(2025, 0, 1);
    const from = day + 18.5 * 3_600_000;
    const to = day + 86_400_000 + 18.5 * 3_600_000;
    await new D1EndpointWriter(db).accept(
      'runtime-app',
      'prod',
      'worker',
      'r1',
      [
        {
          event_id: 'before',
          timestamp: from - 30_000,
          method: 'GET',
          route: '/health',
          status_code: 200,
          duration_ms: 10,
          response_bytes: 50,
        },
        {
          event_id: 'edge',
          timestamp: from + 30_000,
          method: 'GET',
          route: '/health',
          status_code: 503,
          duration_ms: 25,
          response_bytes: 150,
          upstream_sampled: true,
        },
        {
          event_id: 'interior',
          timestamp: day + 23 * 3_600_000,
          method: 'GET',
          route: '/health',
          status_code: 200,
          duration_ms: 100,
          response_bytes: 75,
        },
        {
          event_id: 'next-edge',
          timestamp: to - 30_000,
          method: 'GET',
          route: '/health',
          status_code: 200,
          duration_ms: 2,
        },
      ],
      { now: Date.now() },
    );
    const before = await readEndpointBuckets(db, 'runtime-app', 'prod', from, to, bucket);
    expect(before[0]).toMatchObject({
      request_count: 3,
      error_count: 1,
      upstream_sampled: true,
      response_bytes_sum: 225,
      response_bytes_measured: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      const result = await compactEndpointRollupPartition({
        db,
        bucket,
        now: Date.now(),
        retire: true,
      });
      expect(result.state).toBe('retired');
      expect(await readEndpointBuckets(db, 'runtime-app', 'prod', from, to, bucket)).toEqual(
        before,
      );
    }
    expect(
      await compactEndpointRollupPartition({ db, bucket, now: Date.now(), retire: true }),
    ).toEqual({ state: 'idle', rows: 0 });
    expect(
      (await db.prepare('SELECT DISTINCT resolution_ms FROM endpoint_rollups').all()).results,
    ).toEqual([{ resolution_ms: 86400000 }]);
    expect((await runtimeBucket.list()).objects).toHaveLength(4);
    await expect(readEndpointBuckets(db, 'runtime-app', 'prod', from, to)).rejects.toThrow(
      'history is unavailable',
    );
  } finally {
    await mf.dispose();
  }
}, 20_000);
