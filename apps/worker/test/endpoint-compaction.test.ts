import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';
import { readDailyApiActivity } from '../src/daily-engagement-report.js';
import { compactEndpointRollupPartition } from '../src/endpoint-compaction.js';
import { readEndpointBuckets } from '../src/endpoint-read.js';
import { D1EndpointWriter } from '../src/endpoint-durable.js';
import { MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES } from '../src/endpoint-cold-archive.js';

const DAY = Date.UTC(2026, 5, 30);
const INDIA_DAY_START = DAY + 18.5 * 60 * 60 * 1000;
const APP = 'compaction-app';
const ENV = 'compaction-env';
const APP_CATALOG = {
  catalog_id: 'catalog-compaction',
  app_id: APP,
  catalog_name: 'Compaction test',
  environment_id: ENV,
  analytics_first_received_at: null,
};

class SQLiteStatement implements D1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.values) as T[] };
  }

  async run(): Promise<D1RunResult> {
    const result = this.db.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  execute(): D1RunResult {
    if (/^\s*(?:SELECT|WITH)\b/i.test(this.query))
      return {
        success: true,
        results: this.db.prepare(this.query).all(...this.values) as Record<string, unknown>[],
        meta: { changes: 0 },
      };
    const result = this.db.prepare(this.query).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

class SQLiteD1 implements D1DatabaseLike {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    return new SQLiteStatement(this.sqlite, query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => (statement as SQLiteStatement).execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

class SnapshotRaceD1 implements D1DatabaseLike {
  afterSnapshot?: () => Promise<void>;

  constructor(private readonly inner: SQLiteD1) {}

  prepare(query: string): D1PreparedStatement {
    return this.inner.prepare(query);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
    const results = await this.inner.batch(statements);
    const hook = this.afterSnapshot;
    this.afterSnapshot = undefined;
    await hook?.();
    return results;
  }
}

type StoredObject = { bytes: Uint8Array };
class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  afterPut?: () => void;
  waitOnPut?: { started: () => void; release: Promise<void> };

  async put(key: string, body: ArrayBuffer, options?: R2PutOptions): Promise<R2Object | null> {
    if (options?.onlyIf && 'etagDoesNotMatch' in options.onlyIf && this.objects.has(key))
      return null;
    const bytes = new Uint8Array(body.slice(0));
    this.objects.set(key, { bytes });
    this.afterPut?.();
    if (this.waitOnPut) {
      this.waitOnPut.started();
      await this.waitOnPut.release;
    }
    return { key, size: bytes.byteLength } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    return {
      key,
      size: stored.bytes.byteLength,
      body: new Blob([stored.bytes]).stream(),
    } as R2ObjectBody;
  }
}

const r2Bucket = (fake: FakeR2): Pick<R2Bucket, 'put' | 'get'> =>
  fake as unknown as Pick<R2Bucket, 'put' | 'get'>;

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(`CREATE TABLE environments (
    id TEXT NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY (id, app_id)
  )`);
  sqlite.prepare('INSERT INTO environments VALUES (?, ?, ?)').run(ENV, APP, 'production');
  sqlite.exec(
    'CREATE TABLE catalog_project_imports (app_id TEXT, workspace_id TEXT, lifecycle TEXT)',
  );
  sqlite
    .prepare('INSERT INTO catalog_project_imports VALUES (?, ?, ?)')
    .run(APP, 'workspace-compaction', 'active');
  for (const migration of [
    '0014_endpoint_rollups.sql',
    '0015_response_payload_bytes.sql',
    '0027_endpoint_cold_archives.sql',
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  return { sqlite, db: new SQLiteD1(sqlite) };
}

function measurement(id: string, timestamp: number, duration: number, status = 200) {
  return {
    event_id: id,
    timestamp,
    method: 'GET',
    route: '/health',
    status_code: status,
    duration_ms: duration,
    response_bytes: 64 + duration,
  };
}

async function seed(db: D1DatabaseLike) {
  const writer = new D1EndpointWriter(db);
  await writer.accept(
    APP,
    ENV,
    'node',
    'release-compaction',
    [
      measurement('at-midnight', DAY + 30_000, 4),
      measurement('before-india-day', INDIA_DAY_START - 30_000, 12, 503),
      measurement('at-india-day', INDIA_DAY_START + 30_000, 250),
      measurement('late-day', DAY + 23 * 60 * 60 * 1000 + 30_000, 25),
    ],
    { now: DAY + 40 * 86_400_000, batchId: 'compaction-fixture' },
  );
}

async function seedEveryMinute(db: D1DatabaseLike) {
  const events = Array.from({ length: 1440 }, (_, index) =>
    measurement(`minute-${index}`, DAY + index * 60_000 + 1_000, (index % 4) + 1),
  );
  await new D1EndpointWriter(db).accept(APP, ENV, 'node', 'release-compaction', events, {
    now: DAY + 40 * 86_400_000,
    batchId: 'full-day-partition',
  });
}

async function countRows(sqlite: DatabaseSync, resolution?: number): Promise<number> {
  const query = resolution
    ? sqlite.prepare('SELECT COUNT(*) AS n FROM endpoint_rollups WHERE resolution_ms = ?')
    : sqlite.prepare('SELECT COUNT(*) AS n FROM endpoint_rollups');
  return Number((resolution ? query.get(resolution) : query.get())?.n);
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('endpoint rollup compaction', () => {
  it('keeps archive-only snapshots shadowed and retires verified minutes with exact boundary reads', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const beforeMinuteRows = await countRows(sqlite, 60_000);
    const r2 = new FakeR2();
    const now = DAY + 40 * 86_400_000;

    const shadow = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now,
      retire: false,
    });
    expect(shadow.state).toBe('archived');
    expect(shadow.manifest?.source_removed_at).toBeNull();
    expect(shadow.manifest?.completed_at).toBeGreaterThanOrEqual(now);
    expect(await countRows(sqlite, 60_000)).toBe(beforeMinuteRows);

    const retired = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now,
      retire: true,
    });
    expect(retired.state).toBe('retired');
    expect(retired.manifest?.source_removed_at).toBeGreaterThanOrEqual(
      retired.manifest?.completed_at ?? Number.MAX_SAFE_INTEGER,
    );
    expect(
      Number(
        sqlite.prepare('SELECT source_removed_at FROM endpoint_cold_archives LIMIT 1').get()
          ?.source_removed_at,
      ),
    ).toBeGreaterThanOrEqual(now);
    expect(await countRows(sqlite, 60_000)).toBe(0);
    expect(await countRows(sqlite, 3_600_000)).toBe(3);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 10)));
    const indiaBoundary = await readEndpointBuckets(
      db,
      APP,
      ENV,
      INDIA_DAY_START - 60_000,
      INDIA_DAY_START + 60_000,
      r2Bucket(r2),
    );
    expect(indiaBoundary).toHaveLength(1);
    expect(indiaBoundary[0]).toMatchObject({ request_count: 2, error_count: 1 });
    expect(indiaBoundary[0]?.histogram.reduce((sum, count) => sum + count, 0)).toBe(2);

    const localDay = await readEndpointBuckets(
      db,
      APP,
      ENV,
      INDIA_DAY_START,
      INDIA_DAY_START + 86_400_000,
      r2Bucket(r2),
    );
    expect(localDay).toHaveLength(1);
    expect(localDay[0]?.request_count).toBe(2);
    expect(localDay[0]?.histogram.reduce((sum, count) => sum + count, 0)).toBe(2);

    const daily = await readDailyApiActivity(
      db,
      'workspace-compaction',
      DAY,
      DAY + 86_400_000,
      [APP_CATALOG],
      r2Bucket(r2),
    );
    expect(daily).toEqual([{ app_id: APP, request_count: 4, upstream_sampled: 0 }]);
  });

  it('does not retire when hourly or daily aggregates disagree', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    sqlite.prepare('UPDATE endpoint_rollups SET h0 = h0 + 1 WHERE resolution_ms = 3600000').run();
    await expect(
      compactEndpointRollupPartition({
        db,
        bucket: r2Bucket(new FakeR2()),
        now: DAY + 40 * 86_400_000,
        retire: true,
      }),
    ).rejects.toThrow('Endpoint coarser aggregate mismatch');
    expect(await countRows(sqlite, 60_000)).toBe(4);
    expect(
      Number(sqlite.prepare('SELECT COUNT(*) AS n FROM endpoint_cold_archives').get()?.n),
    ).toBe(0);
  });

  it('leaves changed hot rows in place when they change after the archive PUT', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const r2 = new FakeR2();
    let updated = false;
    r2.afterPut = () => {
      if (updated) return;
      updated = true;
      sqlite
        .prepare('UPDATE endpoint_rollups SET error_count = 0 WHERE resolution_ms = 60000')
        .run();
    };
    const result = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now: DAY + 40 * 86_400_000,
      retire: true,
    });
    expect(result.state).toBe('changed');
    expect(await countRows(sqlite, 60_000)).toBe(4);
    expect(result.manifest?.source_removed_at).toBeNull();
  });

  it('rolls back manifest retirement and deletion when the D1 delete aborts', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    sqlite.exec(`CREATE TRIGGER reject_endpoint_retirement BEFORE DELETE ON endpoint_rollups
      WHEN OLD.resolution_ms = 60000 BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
    await expect(
      compactEndpointRollupPartition({
        db,
        bucket: r2Bucket(new FakeR2()),
        now: DAY + 40 * 86_400_000,
        retire: true,
      }),
    ).rejects.toThrow('injected delete failure');
    expect(await countRows(sqlite, 60_000)).toBe(4);
    expect(
      Number(
        sqlite
          .prepare(
            'SELECT COUNT(*) AS n FROM endpoint_cold_archives WHERE source_removed_at IS NOT NULL',
          )
          .get()?.n,
      ),
    ).toBe(0);
  });

  it('fails closed if retired history is missing or checksum-corrupt', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const r2 = new FakeR2();
    await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now: DAY + 40 * 86_400_000,
      retire: true,
    });
    const sourceRemoved = sqlite
      .prepare('SELECT source_removed_at FROM endpoint_cold_archives LIMIT 1')
      .get()?.source_removed_at;
    expect(Number(sourceRemoved)).toBeGreaterThanOrEqual(DAY + 40 * 86_400_000);
    const storedEntries = [...r2.objects.entries()].map(
      ([key, object]) => [key, object.bytes.slice()] as const,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 10)));
    r2.objects.clear();
    await expect(
      readEndpointBuckets(db, APP, ENV, DAY, DAY + 60_000, r2Bucket(r2)),
    ).rejects.toThrow('Endpoint cold archive object is missing');
    for (const [key, bytes] of storedEntries) {
      bytes[0] = bytes[0]! ^ 0xff;
      r2.objects.set(key, { bytes });
    }
    await expect(
      readEndpointBuckets(db, APP, ENV, DAY, DAY + 60_000, r2Bucket(r2)),
    ).rejects.toThrow('checksum mismatch');
  });

  it('allows a single concurrent retirement and prevents a late archive completion from retiring', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const r2 = new FakeR2();
    const args = { db, bucket: r2Bucket(r2), now: DAY + 40 * 86_400_000, retire: true };
    const concurrent = await Promise.all([
      compactEndpointRollupPartition(args),
      compactEndpointRollupPartition(args),
    ]);
    expect(concurrent.map((result) => result.state).sort()).toEqual(['changed', 'retired']);
    expect(await countRows(sqlite, 60_000)).toBe(0);

    const { sqlite: lateSqlite, db: lateDb } = database();
    databases.push(lateSqlite);
    await seed(lateDb);
    const lateR2 = new FakeR2();
    let signalStarted!: () => void;
    let releasePut!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const release = new Promise<void>((resolve) => (releasePut = resolve));
    lateR2.waitOnPut = { started: signalStarted, release };
    const pending = compactEndpointRollupPartition({
      db: lateDb,
      bucket: r2Bucket(lateR2),
      now: DAY + 40 * 86_400_000,
      retire: true,
      maxRuntimeMs: 25,
    });
    await started;
    await expect(pending).rejects.toThrow('Endpoint compaction time budget exceeded');
    releasePut();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await countRows(lateSqlite, 60_000)).toBe(4);
    expect(
      Number(
        lateSqlite
          .prepare(
            'SELECT COUNT(*) AS n FROM endpoint_cold_archives WHERE source_removed_at IS NOT NULL',
          )
          .get()?.n,
      ),
    ).toBe(0);
  });

  it('retires minute then hour history after 400 days while retaining exact local and daily reads', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const now = DAY + 401 * 86_400_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const r2 = new FakeR2();
    const localRange = [INDIA_DAY_START, INDIA_DAY_START + 86_400_000] as const;

    const beforeEdge = await readEndpointBuckets(
      db,
      APP,
      ENV,
      INDIA_DAY_START - 60_000,
      INDIA_DAY_START + 60_000,
      r2Bucket(r2),
    );
    expect(beforeEdge[0]).toMatchObject({ request_count: 2, error_count: 1 });
    const beforeLocal = await readEndpointBuckets(db, APP, ENV, ...localRange, r2Bucket(r2));
    expect(beforeLocal[0]?.request_count).toBe(2);
    const beforeDaily = await readDailyApiActivity(
      db,
      'workspace-compaction',
      DAY,
      DAY + 86_400_000,
      [APP_CATALOG],
      r2Bucket(r2),
    );
    expect(beforeDaily).toEqual([{ app_id: APP, request_count: 4, upstream_sampled: 0 }]);

    const minuteArchive = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now,
      retire: true,
    });
    expect(minuteArchive.state).toBe('retired');
    expect(minuteArchive.manifest?.resolution_ms).toBe(60_000);
    expect(await countRows(sqlite, 60_000)).toBe(0);
    const hourArchive = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(r2),
      now,
      retire: true,
    });
    expect(hourArchive.state).toBe('retired');
    expect(hourArchive.manifest?.resolution_ms).toBe(3_600_000);
    expect(await countRows(sqlite, 3_600_000)).toBe(0);
    expect(await countRows(sqlite, 86_400_000)).toBe(1);
    expect(
      Number(sqlite.prepare('SELECT SUM(request_count) AS n FROM endpoint_rollups').get()?.n),
    ).toBe(4);

    const indiaEdge = await readEndpointBuckets(
      db,
      APP,
      ENV,
      INDIA_DAY_START - 60_000,
      INDIA_DAY_START + 60_000,
      r2Bucket(r2),
    );
    expect(indiaEdge[0]).toMatchObject({ request_count: 2, error_count: 1 });
    expect(indiaEdge[0]?.histogram).toEqual(beforeEdge[0]?.histogram);
    const afterLocal = await readEndpointBuckets(db, APP, ENV, ...localRange, r2Bucket(r2));
    expect(afterLocal[0]?.request_count).toBe(beforeLocal[0]?.request_count);
    expect(afterLocal[0]?.histogram).toEqual(beforeLocal[0]?.histogram);
    const afterDaily = await readDailyApiActivity(
      db,
      'workspace-compaction',
      DAY,
      DAY + 86_400_000,
      [APP_CATALOG],
      r2Bucket(r2),
    );
    expect(afterDaily).toEqual(beforeDaily);
    const completedAt = Number(
      sqlite.prepare('SELECT completed_at FROM endpoint_cold_archives ORDER BY resolution_ms').get()
        ?.completed_at,
    );
    const removedAt = Number(
      sqlite
        .prepare('SELECT source_removed_at FROM endpoint_cold_archives ORDER BY resolution_ms')
        .get()?.source_removed_at,
    );
    expect(removedAt).toBeGreaterThanOrEqual(completedAt);
  });

  it('archives a complete 1440-minute partition within byte caps with substantial gzip reduction', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seedEveryMinute(db);
    const hot = sqlite
      .prepare('SELECT * FROM endpoint_rollups WHERE resolution_ms = 60000 ORDER BY bucket_start')
      .all();
    expect(hot).toHaveLength(1440);
    const rawRowsJsonBytes = new TextEncoder().encode(JSON.stringify(hot)).byteLength;
    const result = await compactEndpointRollupPartition({
      db,
      bucket: r2Bucket(new FakeR2()),
      now: DAY + 40 * 86_400_000,
      retire: false,
    });
    expect(result.state).toBe('archived');
    expect(result.rows).toBe(1440);
    expect(result.manifest?.row_count).toBe(1440);
    expect(result.manifest?.uncompressed_bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(result.manifest?.compressed_bytes).toBeLessThanOrEqual(
      MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES,
    );
    expect(result.manifest?.compressed_bytes).toBeLessThan(rawRowsJsonBytes * 0.2);
    expect(result.manifest?.completed_at).toBeGreaterThanOrEqual(DAY + 40 * 86_400_000);
  });

  it('returns one transaction snapshot when retirement races after the read batch', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    await seed(db);
    const racingDb = new SnapshotRaceD1(db);
    const r2 = new FakeR2();
    const now = DAY + 40 * 86_400_000;
    racingDb.afterSnapshot = async () => {
      const result = await compactEndpointRollupPartition({
        db,
        bucket: r2Bucket(r2),
        now,
        retire: true,
      });
      expect(result.state).toBe('retired');
    };
    const beforeReturn = await readEndpointBuckets(
      racingDb,
      APP,
      ENV,
      INDIA_DAY_START - 60_000,
      INDIA_DAY_START + 60_000,
      r2Bucket(r2),
    );
    expect(beforeReturn[0]?.request_count).toBe(2);
    expect(await countRows(sqlite, 60_000)).toBe(0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DAY + 401 * 86_400_000));
    const afterRetirement = await readEndpointBuckets(
      racingDb,
      APP,
      ENV,
      INDIA_DAY_START - 60_000,
      INDIA_DAY_START + 60_000,
      r2Bucket(r2),
    );
    expect(afterRetirement[0]?.request_count).toBe(2);
    expect(afterRetirement[0]?.histogram).toEqual(beforeReturn[0]?.histogram);
  });
});
