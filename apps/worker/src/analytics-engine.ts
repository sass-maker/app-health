import { browserQuery } from './browser-query.js';
import {
  LATENCY_HISTOGRAM_BUCKETS,
  MAX_METHOD_LENGTH,
  MAX_ROUTE_LENGTH,
  WINDOW_MS,
  type BucketV1,
  type Runtime,
  type Window,
} from '@app-health/contracts';
import { histogramIndex } from './in-memory-adapter.js';
import { EndpointCapacityError, validateEndpointCapacity } from './endpoint-capacity.js';
import type { BucketRepository } from './repository.js';

export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void;
}

interface QueryRow {
  method: string;
  route: string;
  latency_bucket: string | number;
  request_count: string | number;
  error_count: string | number;
  duration_sum_ms: string | number;
  last_seen: string | number | null;
  upstream_sampled?: string | number | null;
  sample_interval?: string | number;
}

const DATASET = 'app_health_endpoint_v1';
const MAX_POINTS = 250;
const MAX_QUERY_ROWS = 10_000;
export async function telemetryScope(appId: string, envId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${appId}\u0000${envId}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class AnalyticsEngineBuckets implements BucketRepository {
  constructor(
    private readonly dataset: AnalyticsEngineDatasetLike,
    private readonly query: (sql: string) => Promise<QueryRow[]>,
  ) {}

  validateEvents(
    events: readonly {
      method: string;
      route: string;
      duration_ms: number;
      release?: string;
      environment?: string;
    }[],
    release?: string,
  ): void {
    validateEndpointCapacity(events, release);
  }

  async upsertBucket(): Promise<void> {
    throw new Error('production telemetry requires batched Analytics Engine writes');
  }

  async upsertEvents(
    appId: string,
    envId: string,
    runtime: Runtime,
    batchRelease: string | undefined,
    events: readonly {
      timestamp: number;
      method: string;
      route: string;
      status_code: number;
      duration_ms: number;
      release?: string;
      upstream_sampled?: boolean;
    }[],
  ): Promise<void> {
    const scope = await telemetryScope(appId, envId);
    const points = new Map<
      string,
      {
        method: string;
        route: string;
        bucket: number;
        release: string;
        count: number;
        errors: number;
        duration: number;
        lastSeen: number;
        upstreamSampled: boolean;
      }
    >();
    for (const event of events) {
      const bucket = histogramIndex(event.duration_ms);
      const release = event.release ?? batchRelease ?? '';
      const key = `${event.method}\u0000${event.route}\u0000${bucket}\u0000${runtime}\u0000${release}`;
      const point = points.get(key) ?? {
        method: event.method,
        route: event.route,
        bucket,
        release,
        count: 0,
        errors: 0,
        duration: 0,
        lastSeen: 0,
        upstreamSampled: false,
      };
      point.count += 1;
      point.errors += event.status_code >= 500 ? 1 : 0;
      point.duration += event.duration_ms;
      point.lastSeen = Math.max(point.lastSeen, event.timestamp);
      point.upstreamSampled ||= event.upstream_sampled === true;
      points.set(key, point);
    }
    if (points.size > MAX_POINTS) throw new EndpointCapacityError();
    for (const point of points.values()) {
      this.dataset.writeDataPoint({
        indexes: [scope],
        blobs: [
          point.method,
          point.route,
          String(point.bucket),
          runtime,
          point.release,
          point.upstreamSampled ? 'sampled' : '',
        ],
        doubles: [point.count, point.errors, point.duration, point.lastSeen],
      });
    }
  }

  async queryBuckets(appId: string, envId: string, from: number, to: number): Promise<BucketV1[]> {
    windowFor(to - from);
    const scope = await telemetryScope(appId, envId);
    // Analytics Engine is append-only. This exact release was a manually
    // injected connectivity check, not application traffic, so query-tombstone
    // it after its durable D1 inventory and installation state are removed.
    const sql = `SELECT blob1 AS method, blob2 AS route, blob3 AS latency_bucket, SUM(double1 * _sample_interval) AS request_count, SUM(double2 * _sample_interval) AS error_count, SUM(double3 * _sample_interval) AS duration_sum_ms, MAX(double4) AS last_seen, MAX(IF(blob6 = 'sampled', 1, 0)) AS upstream_sampled, MAX(_sample_interval) AS sample_interval FROM ${DATASET} WHERE index1 = '${scope}' AND blob5 != 'polaris-staging-canary' AND timestamp >= toDateTime(${Math.floor(from / 1000)}) AND timestamp < toDateTime(${Math.ceil(to / 1000)}) GROUP BY method, route, latency_bucket ORDER BY method, route, latency_bucket`;
    const rows = await this.query(sql);
    if (rows.length > MAX_QUERY_ROWS)
      throw new Error('Analytics Engine query returned too many rows');
    const grouped = new Map<string, BucketV1>();
    for (const row of rows) {
      validateQueryRow(row);
      const key = `${row.method}\u0000${row.route}`;
      const bucket = grouped.get(key) ?? {
        app_id: appId,
        environment_id: envId,
        bucket_start: from,
        method: row.method,
        route: row.route,
        request_count: 0,
        error_count: 0,
        duration_sum_ms: 0,
        last_seen: null,
        ...(Number(row.upstream_sampled) > 0 ? { upstream_sampled: true } : {}),
        histogram: new Array<number>(LATENCY_HISTOGRAM_BUCKETS).fill(0),
      };
      const count = Math.max(0, Math.round(Number(row.request_count)));
      const bucketIndex = Number(row.latency_bucket);
      if (
        Number.isInteger(bucketIndex) &&
        bucketIndex >= 0 &&
        bucketIndex < bucket.histogram.length
      ) {
        bucket.histogram[bucketIndex] += count;
      }
      bucket.request_count += count;
      bucket.error_count += Math.max(0, Math.round(Number(row.error_count)));
      bucket.duration_sum_ms += Math.max(0, Math.round(Number(row.duration_sum_ms)));
      const lastSeen = row.last_seen === null ? null : Number(row.last_seen);
      if (Number.isFinite(lastSeen)) bucket.last_seen = Math.max(bucket.last_seen ?? 0, lastSeen!);
      if (Number(row.upstream_sampled) > 0) bucket.upstream_sampled = true;
      if (Number(row.sample_interval) > 1) bucket.sampled = true;
      grouped.set(key, bucket);
    }
    return [...grouped.values()];
  }
}

function windowFor(duration: number): Window {
  const entry = (Object.entries(WINDOW_MS) as [Window, number][]).find(
    ([, value]) => Math.abs(value - duration) < 1000,
  );
  if (!entry) throw new Error('unsupported Analytics Engine query window');
  return entry[0];
}

export function createAnalyticsQuery(options: {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
}) {
  if (!/^[a-f0-9]{32}$/i.test(options.accountId)) throw new Error('invalid Cloudflare account id');
  if (!options.token) throw new Error('missing Analytics Engine query token');
  return async (sql: string): Promise<QueryRow[]> => {
    const response = await browserQuery(sql, options);
    if (!response.ok) throw new Error(`Analytics Engine query failed: ${response.status}`);
    const payload: unknown = await response.json();
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !Array.isArray((payload as { data?: unknown }).data)
    ) {
      throw new Error('Analytics Engine query returned invalid data');
    }
    return (payload as { data: QueryRow[] }).data;
  };
}

function validateQueryRow(row: QueryRow): void {
  if (!isQueryRowShape(row)) throw new Error('Analytics Engine query returned invalid row');
  const bucket = Number(row.latency_bucket);
  const count = Number(row.request_count);
  const errors = Number(row.error_count);
  const duration = Number(row.duration_sum_ms);
  const lastSeen = row.last_seen === null ? null : Number(row.last_seen);
  if (
    !Number.isInteger(bucket) ||
    bucket < 0 ||
    bucket >= LATENCY_HISTOGRAM_BUCKETS ||
    !validMetric(count) ||
    !validMetric(errors) ||
    errors > count ||
    !validMetric(duration) ||
    (lastSeen !== null && (!Number.isFinite(lastSeen) || lastSeen < 0))
  ) {
    throw new Error('Analytics Engine query returned invalid row');
  }
  if (row.method.includes('\u0000') || row.route.includes('\u0000'))
    throw new Error('Analytics Engine query returned invalid row');
}

function isQueryRowShape(row: QueryRow | null | undefined): row is QueryRow {
  if (!row || typeof row.method !== 'string' || typeof row.route !== 'string') return false;
  if (!row.method || row.method.length > MAX_METHOD_LENGTH) return false;
  if (!row.route || row.route.length > MAX_ROUTE_LENGTH) return false;
  if (row.last_seen !== null && !isNumericField(row.last_seen)) return false;
  if (
    row.sample_interval !== undefined &&
    (!isNumericField(row.sample_interval) || Number(row.sample_interval) < 1)
  )
    return false;
  return [row.latency_bucket, row.request_count, row.error_count, row.duration_sum_ms].every(
    isNumericField,
  );
}

function isNumericField(value: unknown): value is number | string {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0)
  );
}

function validMetric(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
