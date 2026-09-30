import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import {
  LATENCY_BUCKET_BOUNDS_MS,
  LEGACY_LATENCY_BUCKET_BOUNDS_MS,
  type Runtime,
} from '@app-health/contracts';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';
import {
  archiveEndpointRollupSnapshot,
  endpointColdArchiveObjectKey,
  MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES,
  MAX_ENDPOINT_COLD_ARCHIVE_ROWS,
  readEndpointColdArchiveRows,
  type EndpointColdArchiveManifest,
  type EndpointColdArchiveRange,
  type EndpointRollupColdRow,
} from '../src/endpoint-cold-archive.js';

const DAY = Date.UTC(2026, 8, 30);
const RANGE: EndpointColdArchiveRange = {
  app_id: 'app-cold-test',
  environment_id: 'environment-cold-test',
  resolution_ms: 60_000,
  bucket_from: DAY,
  bucket_to: DAY + 86_400_000,
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
    if (/^\s*SELECT\b/i.test(this.query)) {
      return {
        success: true,
        results: this.db.prepare(this.query).all(...this.values) as Record<string, unknown>[],
        meta: { changes: 0 },
      };
    }
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

type StoredObject = { bytes: Uint8Array };

class FakeR2 {
  readonly objects = new Map<string, StoredObject>();
  loseNextPutResponse = false;
  corruptNextPut = false;

  async put(key: string, body: ArrayBuffer, options?: R2PutOptions): Promise<R2Object | null> {
    const onlyIf = options?.onlyIf;
    if (
      onlyIf &&
      'etagDoesNotMatch' in onlyIf &&
      onlyIf.etagDoesNotMatch === '*' &&
      this.objects.has(key)
    )
      return null;
    let bytes = new Uint8Array(body.slice(0));
    if (this.corruptNextPut) {
      this.corruptNextPut = false;
      bytes = bytes.slice(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
    }
    this.objects.set(key, { bytes });
    if (this.loseNextPutResponse) {
      this.loseNextPutResponse = false;
      throw new Error('simulated lost PUT response');
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

function bucket(fake: FakeR2): Pick<R2Bucket, 'put' | 'get'> {
  return fake as unknown as Pick<R2Bucket, 'put' | 'get'>;
}

function row(overrides: Partial<EndpointRollupColdRow> = {}): EndpointRollupColdRow {
  return {
    app_id: RANGE.app_id,
    environment_id: RANGE.environment_id,
    resolution_ms: RANGE.resolution_ms,
    bucket_start: DAY,
    method: 'GET',
    route: '/health',
    runtime: 'worker' as Runtime,
    release: 'release-1',
    histogram_bounds_ms: JSON.stringify(LATENCY_BUCKET_BOUNDS_MS),
    request_count: 3,
    error_count: 1,
    duration_sum_ms: 425,
    response_bytes_sum: 1024,
    response_bytes_measured: 2,
    last_seen: DAY + 59_999,
    upstream_sampled: 0,
    h0: 1,
    h1: 1,
    h2: 0,
    h3: 0,
    h4: 0,
    h5: 0,
    h6: 0,
    h7: 0,
    h8: 0,
    h9: 0,
    h10: 0,
    h11: 0,
    h12: 0,
    h13: 0,
    h14: 0,
    h15: 1,
    ...overrides,
  };
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(
    `CREATE TABLE environments (id TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (id, app_id));`,
  );
  sqlite
    .prepare('INSERT INTO environments (id, app_id) VALUES (?, ?)')
    .run(RANGE.environment_id, RANGE.app_id);
  sqlite.exec(
    readFileSync(new URL('../migrations/0014_endpoint_rollups.sql', import.meta.url), 'utf8'),
  );
  sqlite.exec(
    readFileSync(new URL('../migrations/0015_response_payload_bytes.sql', import.meta.url), 'utf8'),
  );
  sqlite.exec(
    readFileSync(new URL('../migrations/0027_endpoint_cold_archives.sql', import.meta.url), 'utf8'),
  );
  return { sqlite, db: new SQLiteD1(sqlite) };
}

function toBytes(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function sha256(value: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe('verified endpoint cold archives', () => {
  it('round trips all persisted dimensions and counters, then retries idempotently', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    const r2 = new FakeR2();
    r2.loseNextPutResponse = true;
    const rows = [
      row(),
      row({
        bucket_start: DAY + 60_000,
        last_seen: DAY + 119_000,
        h0: 0,
        h1: 0,
        h2: 1,
        h3: 0,
        h4: 0,
        h15: 2,
      }),
    ];
    const manifest = await archiveEndpointRollupSnapshot(bucket(r2), db, {
      range: RANGE,
      rows,
      now: DAY + 86_400_000,
    });
    expect(manifest.source_removed_at).toBeNull();
    expect(manifest.row_count).toBe(2);
    expect(await readEndpointColdArchiveRows(bucket(r2), manifest)).toEqual(rows);
    const legacy = await archiveEndpointRollupSnapshot(bucket(r2), db, {
      range: RANGE,
      rows: [row({ histogram_bounds_ms: JSON.stringify(LEGACY_LATENCY_BUCKET_BOUNDS_MS) })],
      now: DAY + 86_400_000,
    });
    expect((await readEndpointColdArchiveRows(bucket(r2), legacy))[0]?.histogram_bounds_ms).toBe(
      JSON.stringify(LEGACY_LATENCY_BUCKET_BOUNDS_MS),
    );
    const retry = await archiveEndpointRollupSnapshot(bucket(r2), db, {
      range: RANGE,
      rows,
      now: DAY + 86_400_100,
    });
    expect(retry.object_key).toBe(manifest.object_key);
    expect(retry.completed_at).toBe(manifest.completed_at);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM endpoint_cold_archives').get()).toEqual({
      count: 2,
    });
  });

  it('rejects mixed tenant rows and nonconserving histograms before writing an object', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    const r2 = new FakeR2();
    await expect(
      archiveEndpointRollupSnapshot(bucket(r2), db, {
        range: RANGE,
        rows: [row(), row({ bucket_start: DAY + 60_000, app_id: 'another-app' })],
        now: DAY,
      }),
    ).rejects.toThrow('Invalid endpoint cold archive row');
    await expect(
      archiveEndpointRollupSnapshot(bucket(r2), db, {
        range: RANGE,
        rows: [
          row(),
          row({
            bucket_start: DAY + 60_000,
            last_seen: DAY + 119_000,
            histogram_bounds_ms: JSON.stringify(LEGACY_LATENCY_BUCKET_BOUNDS_MS),
          }),
        ],
        now: DAY,
      }),
    ).rejects.toThrow('spans multiple series');
    await expect(
      archiveEndpointRollupSnapshot(bucket(r2), db, {
        range: RANGE,
        rows: [row({ h0: 0 })],
        now: DAY,
      }),
    ).rejects.toThrow('does not conserve requests');
    expect(r2.objects.size).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM endpoint_cold_archives').get()).toEqual({
      count: 0,
    });
  });

  it('records no manifest when put readback is corrupt and rejects later checksum corruption', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    const r2 = new FakeR2();
    r2.corruptNextPut = true;
    await expect(
      archiveEndpointRollupSnapshot(bucket(r2), db, { range: RANGE, rows: [row()], now: DAY }),
    ).rejects.toThrow('readback failed');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM endpoint_cold_archives').get()).toEqual({
      count: 0,
    });

    r2.objects.clear();
    const valid = await archiveEndpointRollupSnapshot(bucket(r2), db, {
      range: RANGE,
      rows: [row()],
      now: DAY,
    });
    const stored = r2.objects.get(valid.object_key)!;
    stored.bytes[0] = stored.bytes[0]! ^ 0xff;
    await expect(readEndpointColdArchiveRows(bucket(r2), valid)).rejects.toThrow(
      'checksum mismatch',
    );
  });

  it('caps decompression even when a checksummed gzip object expands beyond the limit', async () => {
    const r2 = new FakeR2();
    const bomb = await new Response(
      new Blob([' '.repeat(MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES * 3)])
        .stream()
        .pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    const compressed = new Uint8Array(bomb);
    expect(compressed.byteLength).toBeLessThan(MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES);
    const digest = await sha256(compressed);
    const manifest: EndpointColdArchiveManifest = {
      ...RANGE,
      object_key: endpointColdArchiveObjectKey({ ...RANGE, content_sha256: digest }),
      content_sha256: digest,
      row_count: 1,
      uncompressed_bytes: 1,
      compressed_bytes: compressed.byteLength,
      schema_version: 1,
      completed_at: DAY,
      source_removed_at: null,
    };
    r2.objects.set(manifest.object_key, { bytes: compressed });
    await expect(readEndpointColdArchiveRows(bucket(r2), manifest)).rejects.toThrow(
      'gzip is invalid or exceeds its byte limit',
    );
  });

  it('enforces the maximum snapshot row count before storage', async () => {
    const { sqlite, db } = database();
    databases.push(sqlite);
    const rows = Array.from({ length: MAX_ENDPOINT_COLD_ARCHIVE_ROWS + 1 }, (_, index) =>
      row({ route: `/r/${index}` }),
    );
    await expect(
      archiveEndpointRollupSnapshot(bucket(new FakeR2()), db, { range: RANGE, rows, now: DAY }),
    ).rejects.toThrow('row count is outside its limit');
  });
});
