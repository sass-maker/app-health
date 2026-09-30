import type { D1DatabaseLike } from './d1-adapter.js';
import {
  archiveEndpointRollupSnapshot,
  ENDPOINT_COLD_ROW_COLUMNS,
  type EndpointColdArchiveManifest,
  type EndpointRollupColdRow,
} from './endpoint-cold-archive.js';

const DAY = 86_400_000;
export const ENDPOINT_MINUTE_HOT_DAYS = 35;
const ENDPOINT_HOUR_HOT_DAYS = 400;
const MAX_PARTITION_ROWS = 1440;
const MAX_RETIRE_JSON_BYTES = 1_900_000;
const DIMENSIONS = [
  'app_id',
  'environment_id',
  'method',
  'route',
  'runtime',
  'release',
  'histogram_bounds_ms',
] as const;
const DIMENSION_FILTER = DIMENSIONS.map((column) => column + ' = ?').join(' AND ');
const COUNTERS = [
  'request_count',
  'error_count',
  'response_bytes_measured',
  ...Array.from({ length: 16 }, (_, index) => `h${index}`),
];
const SUMS = [...COUNTERS, 'duration_sum_ms', 'response_bytes_sum'];

function cutoff(resolution: number, now: number): number {
  const days = resolution === 60_000 ? ENDPOINT_MINUTE_HOT_DAYS : ENDPOINT_HOUR_HOT_DAYS;
  return Math.floor((now - days * DAY) / DAY) * DAY;
}

async function candidate(db: D1DatabaseLike, now: number) {
  return db
    .prepare(
      `SELECT ${ENDPOINT_COLD_ROW_COLUMNS.join(',')} FROM endpoint_rollups
    WHERE (resolution_ms = 60000 AND bucket_start < ?)
      OR (resolution_ms = 3600000 AND bucket_start < ?)
    ORDER BY resolution_ms, bucket_start LIMIT 1`,
    )
    .bind(cutoff(60_000, now), cutoff(3_600_000, now))
    .first<EndpointRollupColdRow>();
}

async function snapshot(db: D1DatabaseLike, row: EndpointRollupColdRow) {
  const from = Math.floor(row.bucket_start / DAY) * DAY;
  const result = await db
    .prepare(
      `SELECT ${ENDPOINT_COLD_ROW_COLUMNS.join(',')} FROM endpoint_rollups
    WHERE ${DIMENSION_FILTER}
      AND resolution_ms = ? AND bucket_start >= ? AND bucket_start < ?
    ORDER BY bucket_start LIMIT ${MAX_PARTITION_ROWS + 1}`,
    )
    .bind(...DIMENSIONS.map((column) => row[column]), row.resolution_ms, from, from + DAY)
    .all<EndpointRollupColdRow>();
  if (!result.results.length || result.results.length > MAX_PARTITION_ROWS)
    throw new Error('Endpoint compaction partition exceeds bounds');
  return { rows: result.results, from, to: from + DAY };
}

function aggregate(rows: readonly EndpointRollupColdRow[], resolution: number) {
  const groups = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const bucket = Math.floor(row.bucket_start / resolution) * resolution;
    const total = groups.get(bucket) ?? Object.fromEntries(SUMS.map((column) => [column, 0]));
    for (const column of SUMS) total[column] += Number(row[column as keyof EndpointRollupColdRow]);
    total.last_seen = Math.max(total.last_seen ?? 0, row.last_seen);
    total.upstream_sampled = Math.max(total.upstream_sampled ?? 0, row.upstream_sampled);
    groups.set(bucket, total);
  }
  return groups;
}

function equalAggregate(expected: Record<string, number>, actual: EndpointRollupColdRow) {
  for (const column of [...COUNTERS, 'last_seen', 'upstream_sampled']) {
    if (expected[column] !== Number(actual[column as keyof EndpointRollupColdRow])) return false;
  }
  // SQLite's differently grouped floating sums may differ by rounding only.
  return ['duration_sum_ms', 'response_bytes_sum'].every((column) => {
    const value = Number(actual[column as keyof EndpointRollupColdRow]);
    const tolerance = Math.max(1e-6, Math.abs(expected[column]) * 1e-10);
    return Number.isFinite(value) && Math.abs(expected[column] - value) <= tolerance;
  });
}

async function verifyCoarser(
  db: D1DatabaseLike,
  rows: EndpointRollupColdRow[],
  from: number,
  to: number,
) {
  const first = rows[0];
  const resolutions = first.resolution_ms === 60_000 ? [3_600_000, DAY] : [DAY];
  for (const resolution of resolutions) {
    const result = await db
      .prepare(
        `SELECT ${ENDPOINT_COLD_ROW_COLUMNS.join(',')} FROM endpoint_rollups
      WHERE ${DIMENSION_FILTER}
        AND resolution_ms = ? AND bucket_start >= ? AND bucket_start < ?
      ORDER BY bucket_start LIMIT 25`,
      )
      .bind(...DIMENSIONS.map((column) => first[column]), resolution, from, to)
      .all<EndpointRollupColdRow>();
    const expected = aggregate(rows, resolution);
    if (result.results.length !== expected.size)
      throw new Error('Endpoint coarser partition mismatch');
    for (const row of result.results) {
      const total = expected.get(row.bucket_start);
      if (!total || !equalAggregate(total, row))
        throw new Error('Endpoint coarser aggregate mismatch');
    }
  }
}

async function retireSnapshot(
  db: D1DatabaseLike,
  manifest: EndpointColdArchiveManifest,
  rows: EndpointRollupColdRow[],
  now: number,
): Promise<boolean> {
  if (manifest.source_removed_at !== null) return false;
  const payload = JSON.stringify(rows);
  if (new TextEncoder().encode(payload).byteLength > MAX_RETIRE_JSON_BYTES)
    throw new Error('Endpoint retirement snapshot exceeds D1 parameter bound');
  const match = ENDPOINT_COLD_ROW_COLUMNS.map(
    (column) => `r.${column} IS json_extract(j.value, '$.${column}')`,
  ).join(' AND ');
  const guard = `SELECT COUNT(*) FROM json_each(?) j JOIN endpoint_rollups r ON ${match}`;
  const partitionCount = `SELECT COUNT(*) FROM endpoint_rollups WHERE ${DIMENSION_FILTER}
    AND resolution_ms = ? AND bucket_start >= ? AND bucket_start < ?`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE endpoint_cold_archives SET source_removed_at = ?
      WHERE object_key = ? AND content_sha256 = ? AND source_removed_at IS NULL
        AND row_count = ? AND (${guard}) = row_count AND (${partitionCount}) = row_count`,
      )
      .bind(
        now,
        manifest.object_key,
        manifest.content_sha256,
        rows.length,
        payload,
        ...DIMENSIONS.map((column) => rows[0][column]),
        manifest.resolution_ms,
        manifest.bucket_from,
        manifest.bucket_to,
      ),
    db
      .prepare(
        `DELETE FROM endpoint_rollups WHERE rowid IN (
      SELECT r.rowid FROM json_each(?) j JOIN endpoint_rollups r ON ${match}
      WHERE changes() = 1 AND EXISTS (SELECT 1 FROM endpoint_cold_archives
        WHERE object_key = ? AND source_removed_at = ?))`,
      )
      .bind(payload, manifest.object_key, now),
  ]);
  if (results.length !== 2 || results.some((result) => !result.success))
    throw new Error('Endpoint retirement transaction failed');
  if (results[0].meta.changes === 0) return false;
  if (results[1].meta.changes !== rows.length)
    throw new Error('Endpoint retirement count mismatch');
  return true;
}

interface CompactionArgs {
  db: D1DatabaseLike;
  bucket: Pick<R2Bucket, 'put' | 'get'>;
  now: number;
  retire: boolean;
  maxRuntimeMs?: number;
}

type CompactionResult = {
  state: 'idle' | 'archived' | 'retired' | 'changed';
  rows: number;
  manifest?: EndpointColdArchiveManifest;
};

function checkDeadline(deadline: number) {
  if (performance.now() >= deadline) throw new Error('Endpoint compaction time budget exceeded');
}

async function runPartition(args: CompactionArgs, deadline: number): Promise<CompactionResult> {
  if (!Number.isSafeInteger(args.now) || args.now <= 0) throw new Error('Invalid compaction time');
  const first = await candidate(args.db, args.now);
  if (!first) return { state: 'idle', rows: 0 };
  const partition = await snapshot(args.db, first);
  checkDeadline(deadline);
  await verifyCoarser(args.db, partition.rows, partition.from, partition.to);
  checkDeadline(deadline);
  const manifest = await archiveEndpointRollupSnapshot(args.bucket, args.db, {
    range: {
      app_id: first.app_id,
      environment_id: first.environment_id,
      resolution_ms: first.resolution_ms,
      bucket_from: partition.from,
      bucket_to: partition.to,
    },
    rows: partition.rows,
    now: args.now,
  });
  // Late completion may leave a verified shadow archive, never retire hot rows.
  checkDeadline(deadline);
  if (!args.retire) return { state: 'archived', rows: partition.rows.length, manifest };
  const retiredAt = Math.max(args.now, manifest.completed_at, Date.now());
  const retired = await retireSnapshot(args.db, manifest, partition.rows, retiredAt);
  return {
    state: retired ? 'retired' : 'changed',
    rows: partition.rows.length,
    manifest: retired ? { ...manifest, source_removed_at: retiredAt } : manifest,
  };
}

/** One bounded full-series UTC-day slice. Inactive until explicitly invoked. */
export async function compactEndpointRollupPartition(
  args: CompactionArgs,
): Promise<CompactionResult> {
  const budget = args.maxRuntimeMs ?? 10_000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 15_000)
    throw new Error('Invalid endpoint compaction time budget');
  const deadline = performance.now() + budget;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Endpoint compaction time budget exceeded')), budget);
  });
  try {
    return await Promise.race([runPartition(args, deadline), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
