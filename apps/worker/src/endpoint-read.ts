import {
  LATENCY_BUCKET_BOUNDS_MS,
  LATENCY_HISTOGRAM_BUCKETS,
  type BucketV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';

const HISTOGRAM = Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, i) => `h${i}`);
const MAX_ROWS = 10_000;

// Cover the interval with disjoint ranges. Daily/hourly interiors avoid reading
// every minute; minute edges keep the requested boundaries exact.
function readRanges(from: number, to: number) {
  let ranges = [{ from, to, resolution: 60_000 }];
  for (const resolution of [86_400_000, 3_600_000]) {
    ranges = ranges.flatMap((range) => {
      if (range.resolution !== 60_000) return [range];
      const start = Math.ceil(range.from / resolution) * resolution;
      const end = Math.floor(range.to / resolution) * resolution;
      if (start >= end) return [range];
      return [
        ...(range.from < start ? [{ ...range, to: start }] : []),
        { from: start, to: end, resolution },
        ...(end < range.to ? [{ ...range, from: end }] : []),
      ];
    });
  }
  return ranges;
}

/** Read completed UTC minutes; indexed scope/range filtering precedes aggregation. */
export async function readEndpointBuckets(
  db: D1DatabaseLike,
  appId: string,
  envId: string,
  from: number,
  to: number,
): Promise<BucketV1[]> {
  if (from % 60_000 || to % 60_000 || to <= from)
    throw new Error('Endpoint reads require completed minute boundaries');
  const values: unknown[] = [appId, envId];
  const sources = readRanges(from, to).map((range) => {
    const offset = values.length;
    values.push(range.from, range.to);
    return `SELECT method, route, histogram_bounds_ms, request_count, error_count,
      duration_sum_ms, last_seen, upstream_sampled, ${HISTOGRAM.join(',')}
      FROM endpoint_rollups WHERE app_id = ?1 AND environment_id = ?2
      AND resolution_ms = ${range.resolution} AND bucket_start >= ?${offset + 1}
      AND bucket_start < ?${offset + 2}`;
  });
  const result = await db
    .prepare(
      `SELECT method, route, histogram_bounds_ms,
    SUM(request_count) AS request_count, SUM(error_count) AS error_count,
    SUM(duration_sum_ms) AS duration_sum_ms, MAX(last_seen) AS last_seen,
    MAX(upstream_sampled) AS upstream_sampled,
    ${HISTOGRAM.map((name) => `SUM(${name}) AS ${name}`).join(',')}
    FROM (${sources.join(' UNION ALL ')})
    GROUP BY method, route, histogram_bounds_ms ORDER BY method, route LIMIT ${MAX_ROWS + 1}`,
    )
    .bind(...values)
    .all<Record<string, unknown>>();
  if (result.results.length > MAX_ROWS) throw new Error('Endpoint query exceeded row limit');
  return result.results.map((row) => decodeEndpointBucket(row, appId, envId, from));
}

function decodeEndpointBucket(
  row: Record<string, unknown>,
  appId: string,
  envId: string,
  from: number,
): BucketV1 {
  if (row.histogram_bounds_ms !== JSON.stringify(LATENCY_BUCKET_BOUNDS_MS))
    throw new Error('Unsupported endpoint histogram schema');
  const histogram = HISTOGRAM.map((name) => Number(row[name]));
  const count = Number(row.request_count);
  const errors = Number(row.error_count);
  const duration = Number(row.duration_sum_ms);
  const lastSeen = Number(row.last_seen);
  if (
    typeof row.method !== 'string' ||
    typeof row.route !== 'string' ||
    ![count, errors, ...histogram].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    errors > count ||
    histogram.reduce((sum, value) => sum + value, 0) !== count ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(lastSeen)
  )
    throw new Error('Invalid durable endpoint aggregate');
  return {
    app_id: appId,
    environment_id: envId,
    bucket_start: from,
    method: row.method,
    route: row.route,
    request_count: count,
    error_count: errors,
    duration_sum_ms: duration,
    last_seen: lastSeen,
    histogram,
    ...(Number(row.upstream_sampled) > 0 ? { upstream_sampled: true } : {}),
  };
}
