import {
  LATENCY_HISTOGRAM_BUCKETS,
  latencyHistogramSchemaFromBounds,
  normalizeLatencyHistogram,
  type BucketV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { endpointReadRanges } from './endpoint-read-ranges.js';
import { readEndpointHistory } from './endpoint-cold-read.js';
export { endpointReadRanges } from './endpoint-read-ranges.js';

const HISTOGRAM = Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, i) => `h${i}`);
const MAX_ROWS = 10_000;

/** Read completed UTC minutes; indexed scope/range filtering precedes aggregation. */
export async function readEndpointBuckets(
  db: D1DatabaseLike,
  appId: string,
  envId: string,
  from: number,
  to: number,
  coldBucket?: Pick<R2Bucket, 'get'>,
): Promise<BucketV1[]> {
  if (from % 60_000 || to % 60_000 || to <= from)
    throw new Error('Endpoint reads require completed minute boundaries');
  const values: unknown[] = [appId, envId];
  const sources = endpointReadRanges(from, to).map((range) => {
    const offset = values.length;
    values.push(range.from, range.to);
    return `SELECT method, route, histogram_bounds_ms, request_count, error_count,
      duration_sum_ms, response_bytes_sum, response_bytes_measured, last_seen, upstream_sampled, ${HISTOGRAM.join(',')}
      FROM endpoint_rollups WHERE app_id = ?1 AND environment_id = ?2
      AND resolution_ms = ${range.resolution} AND bucket_start >= ?${offset + 1}
      AND bucket_start < ?${offset + 2}`;
  });
  const hot = db
    .prepare(
      `SELECT method, route, histogram_bounds_ms,
    SUM(request_count) AS request_count, SUM(error_count) AS error_count,
    SUM(duration_sum_ms) AS duration_sum_ms,
    SUM(response_bytes_sum) AS response_bytes_sum,
    SUM(response_bytes_measured) AS response_bytes_measured,
    MAX(last_seen) AS last_seen,
    MAX(upstream_sampled) AS upstream_sampled,
    ${HISTOGRAM.map((name) => `SUM(${name}) AS ${name}`).join(',')}
    FROM (${sources.join(' UNION ALL ')})
    GROUP BY method, route, histogram_bounds_ms ORDER BY method, route LIMIT ${MAX_ROWS + 1}`,
    )
    .bind(...values);
  const { hotRows, coldRows } = await readEndpointHistory({
    hot,
    db,
    bucket: coldBucket,
    scopes: [{ app_id: appId, environment_id: envId }],
    from,
    to,
    now: Date.now(),
  });
  if (hotRows.length > MAX_ROWS) throw new Error('Endpoint query exceeded row limit');
  const hotBuckets = hotRows.map((row) => decodeEndpointBucket(row, appId, envId, from));
  if (!coldRows.length) return hotBuckets;
  return mergeReadBuckets([
    ...hotBuckets,
    ...coldRows.map((row) => decodeEndpointBucket(row, appId, envId, from)),
  ]);
}

function mergeReadBuckets(buckets: BucketV1[]): BucketV1[] {
  const grouped = new Map<string, BucketV1>();
  for (const bucket of buckets) {
    const key = JSON.stringify([bucket.method, bucket.route]);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...bucket, histogram: [...bucket.histogram] });
      continue;
    }
    existing.request_count += bucket.request_count;
    existing.error_count += bucket.error_count;
    existing.duration_sum_ms += bucket.duration_sum_ms;
    existing.response_bytes_sum =
      (existing.response_bytes_sum ?? 0) + (bucket.response_bytes_sum ?? 0);
    existing.response_bytes_measured =
      (existing.response_bytes_measured ?? 0) + (bucket.response_bytes_measured ?? 0);
    existing.last_seen = Math.max(existing.last_seen ?? 0, bucket.last_seen ?? 0);
    existing.upstream_sampled ||= bucket.upstream_sampled;
    if (bucket.legacy_ambiguous_latency_count)
      existing.legacy_ambiguous_latency_count =
        (existing.legacy_ambiguous_latency_count ?? 0) + bucket.legacy_ambiguous_latency_count;
    for (let index = 0; index < HISTOGRAM.length; index += 1)
      existing.histogram[index] += bucket.histogram[index];
  }
  if (grouped.size > MAX_ROWS) throw new Error('Endpoint query exceeded row limit');
  for (const bucket of grouped.values()) validateCombinedBucket(bucket);
  return [...grouped.values()].sort((a, b) => {
    const first = JSON.stringify([a.method, a.route]);
    const second = JSON.stringify([b.method, b.route]);
    return first < second ? -1 : first > second ? 1 : 0;
  });
}

function validateCombinedBucket(bucket: BucketV1) {
  const counters = [
    bucket.request_count,
    bucket.error_count,
    bucket.response_bytes_measured ?? 0,
    bucket.legacy_ambiguous_latency_count ?? 0,
    ...bucket.histogram,
  ];
  if (
    !counters.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isFinite(bucket.duration_sum_ms) ||
    !Number.isFinite(bucket.response_bytes_sum ?? 0)
  )
    throw new Error('Combined endpoint aggregate exceeds numeric bounds');
}

function decodeEndpointBucket(
  row: Record<string, unknown>,
  appId: string,
  envId: string,
  from: number,
): BucketV1 {
  const schema = latencyHistogramSchemaFromBounds(String(row.histogram_bounds_ms));
  const histogram = HISTOGRAM.map((name) => Number(row[name]));
  const count = Number(row.request_count);
  const errors = Number(row.error_count);
  const duration = Number(row.duration_sum_ms);
  const bytesSum = Number(row.response_bytes_sum);
  const bytesMeasured = Number(row.response_bytes_measured);
  const lastSeen = Number(row.last_seen);
  if (
    typeof row.method !== 'string' ||
    typeof row.route !== 'string' ||
    ![count, errors, ...histogram].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    errors > count ||
    histogram.reduce((sum, value) => sum + value, 0) !== count ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    !Number.isFinite(bytesSum) ||
    bytesSum < 0 ||
    !Number.isSafeInteger(bytesMeasured) ||
    bytesMeasured < 0 ||
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
    response_bytes_sum: bytesSum,
    response_bytes_measured: bytesMeasured,
    last_seen: lastSeen,
    histogram: normalizeLatencyHistogram(histogram, schema),
    ...(schema === 'legacy-v1' && histogram[9] > 0
      ? { legacy_ambiguous_latency_count: histogram[9] }
      : {}),
    ...(Number(row.upstream_sampled) > 0 ? { upstream_sampled: true } : {}),
  };
}
