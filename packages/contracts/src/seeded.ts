// Seeded endpoint metrics for the credential-free in-memory development
// adapter. These fixtures let the dashboard render a populated observed-
// endpoint table without any ingest traffic or production resources.
// Wave 0 only defines the seed shape; the worker wires it into the
// in-memory adapter.

import type { BucketV1, EndpointAggregateV1 } from './aggregate.js';
import { LATENCY_HISTOGRAM_BUCKETS } from './aggregate.js';
import { BUCKET_MS, LATENCY_BUCKET_BOUNDS_MS, MAX_DURATION_MS, WINDOW_MS } from './constants.js';
import { healthState } from './health.js';

/** Seeded app/environment/key identifiers used by the dev adapter. */
export const SEED_APP_ID = 'app-seed-0001';
export const SEED_ENV_ID = 'env-seed-prod';
export const SEED_ENV_NAME = 'prod';
export const SEED_APP_NAME = 'demo-app';
/** Display-only ingest key for the seeded environment. Not a secret. */
export const SEED_KEY = 'ahk_seed_do_not_use_in_production';
/** Display-only browser (public) log key for the seeded environment. Not a secret. */
export const SEED_PUBLIC_KEY = 'ahk_pub_seed_do_not_use_in_production';
export const SEED_PUBLIC_KEY_ORIGINS = ['http://localhost:5173', 'http://localhost:4173'];

const NOW = 1_725_000_000_000;

function bucketStartMinutesAgo(now: number, minutes: number): number {
  return now - minutes * BUCKET_MS;
}

function emptyHistogram(): number[] {
  return new Array<number>(LATENCY_HISTOGRAM_BUCKETS).fill(0);
}

function histogram(samplesMs: number[]): number[] {
  // Bucket index = number of bounds strictly less than the sample, capped at
  // the last (overflow) bucket. Bounds are aligned with LATENCY_BUCKET_BOUNDS_MS.
  const counts = emptyHistogram();
  for (const ms of samplesMs) {
    let idx = 0;
    while (idx < LATENCY_BUCKET_BOUNDS_MS.length && ms > LATENCY_BUCKET_BOUNDS_MS[idx]) idx += 1;
    counts[idx] += 1;
  }
  return counts;
}

/** Build a single seeded bucket. */
function makeBucket(
  now: number,
  minutesAgo: number,
  method: string,
  route: string,
  samples: { status: number; duration_ms: number }[],
): BucketV1 {
  const request_count = samples.length;
  const error_count = samples.filter((s) => s.status >= 500).length;
  const duration_sum_ms = samples.reduce((sum, s) => sum + s.duration_ms, 0);
  const last_seen = bucketStartMinutesAgo(now, minutesAgo) + BUCKET_MS - 1;
  return {
    app_id: SEED_APP_ID,
    environment_id: SEED_ENV_ID,
    bucket_start: bucketStartMinutesAgo(now, minutesAgo),
    method,
    route,
    request_count,
    error_count,
    duration_sum_ms,
    last_seen,
    histogram: histogram(samples.map((s) => s.duration_ms)),
  };
}

/** Seeded one-minute buckets spanning the last ~25 minutes. */
export function buildSeedBuckets(now = Date.now()): readonly BucketV1[] {
  return [
    makeBucket(now, 1, 'GET', '/health', [
      { status: 200, duration_ms: 8 },
      { status: 200, duration_ms: 12 },
      { status: 200, duration_ms: 10 },
      { status: 200, duration_ms: 9 },
      { status: 200, duration_ms: 11 },
    ]),
    makeBucket(now, 2, 'GET', '/users/:id', [
      { status: 200, duration_ms: 45 },
      { status: 200, duration_ms: 52 },
      { status: 404, duration_ms: 38 },
      { status: 200, duration_ms: 48 },
      { status: 200, duration_ms: 60 },
    ]),
    makeBucket(now, 3, 'POST', '/orders', [
      { status: 201, duration_ms: 120 },
      { status: 201, duration_ms: 135 },
      { status: 500, duration_ms: 350 },
      { status: 201, duration_ms: 128 },
      { status: 201, duration_ms: 142 },
    ]),
    makeBucket(now, 5, 'GET', '/orders/:id', [
      { status: 200, duration_ms: 88 },
      { status: 200, duration_ms: 95 },
      { status: 200, duration_ms: 102 },
      { status: 200, duration_ms: 80 },
      { status: 200, duration_ms: 110 },
    ]),
    makeBucket(now, 10, 'GET', '/users/:id', [
      { status: 200, duration_ms: 50 },
      { status: 200, duration_ms: 55 },
      { status: 200, duration_ms: 48 },
      { status: 200, duration_ms: 52 },
      { status: 200, duration_ms: 58 },
    ]),
    makeBucket(now, 20, 'POST', '/orders', [
      { status: 201, duration_ms: 130 },
      { status: 201, duration_ms: 125 },
      { status: 201, duration_ms: 140 },
      { status: 500, duration_ms: 400 },
      { status: 201, duration_ms: 120 },
    ]),
  ] as const;
}

/** Deterministic buckets for contract tests. Runtime adapters build fresh copies. */
export const SEED_BUCKETS: readonly BucketV1[] = buildSeedBuckets(NOW);

/** Approximate p50/p95 from a merged histogram, aligned with bounds. */
export function approximatePercentiles(histogram: readonly number[]): {
  p50_ms: number;
  p95_ms: number;
} {
  const total = histogram.reduce((sum, c) => sum + c, 0);
  if (total === 0) return { p50_ms: 0, p95_ms: 0 };
  const bucketUpperBound = (idx: number): number =>
    idx < LATENCY_BUCKET_BOUNDS_MS.length ? LATENCY_BUCKET_BOUNDS_MS[idx] : MAX_DURATION_MS;
  const valueAtPercentile = (p: number): number => {
    const target = Math.ceil(total * p);
    let running = 0;
    for (let i = 0; i < histogram.length; i += 1) {
      running += histogram[i];
      if (running >= target) return bucketUpperBound(i);
    }
    return bucketUpperBound(histogram.length - 1);
  };
  return { p50_ms: valueAtPercentile(0.5), p95_ms: valueAtPercentile(0.95) };
}

/** Merge buckets for the same (method, route) into an EndpointAggregate. */
export function mergeBuckets(
  buckets: readonly BucketV1[],
  windowLabel: '15m' | '1h' | '24h',
  refreshedAt = NOW,
): EndpointAggregateV1[] {
  const cutoff = refreshedAt - WINDOW_MS[windowLabel];
  const byKey = new Map<string, BucketV1[]>();
  for (const b of buckets) {
    if (b.bucket_start < cutoff || b.bucket_start > refreshedAt) continue;
    const key = `${b.method}|${b.route}`;
    const list = byKey.get(key) ?? [];
    list.push(b);
    byKey.set(key, list);
  }
  const aggregates: EndpointAggregateV1[] = [];
  for (const list of byKey.values()) {
    const request_count = list.reduce((sum, b) => sum + b.request_count, 0);
    if (request_count === 0) continue;
    const error_count = list.reduce((sum, b) => sum + b.error_count, 0);
    const mergedHistogram = emptyHistogram();
    for (const b of list) {
      for (let i = 0; i < mergedHistogram.length; i += 1) {
        mergedHistogram[i] += b.histogram[i];
      }
    }
    const lastSeenList = list.map((b) => b.last_seen).filter((v): v is number => v != null);
    const last_seen = lastSeenList.length ? Math.max(...lastSeenList) : null;
    const { p50_ms, p95_ms } = approximatePercentiles(mergedHistogram);
    const error_rate = request_count > 0 ? error_count / request_count : 0;
    const { method, route } = list[0];
    aggregates.push({
      method,
      route,
      request_count,
      error_count,
      error_rate,
      p50_ms,
      p95_ms,
      last_seen,
      health_state: healthState({ request_count, error_rate, p95_ms }),
      ...(list.some((bucket) => bucket.upstream_sampled) ? { upstream_sampled: true } : {}),
      ...(list.some((bucket) => bucket.sampled) ? { sampled: true } : {}),
    });
  }
  // deterministic default sort: unhealthy > degraded > healthy > insufficient-data,
  // then by request_count desc, then route asc.
  const order: Record<string, number> = {
    unhealthy: 0,
    degraded: 1,
    healthy: 2,
    'insufficient-data': 3,
  };
  aggregates.sort((a, b) => {
    if (order[a.health_state] !== order[b.health_state]) {
      return order[a.health_state] - order[b.health_state];
    }
    if (a.request_count !== b.request_count) return b.request_count - a.request_count;
    return a.route.localeCompare(b.route);
  });
  return aggregates;
}

/** Seeded aggregate response for the dev adapter. */
export function seededAggregateResponse(
  window: '15m' | '1h' | '24h',
  refreshedAt = NOW,
): {
  refreshed_at: number;
  window: '15m' | '1h' | '24h';
  endpoints: EndpointAggregateV1[];
} {
  return {
    refreshed_at: refreshedAt,
    window,
    endpoints: mergeBuckets(SEED_BUCKETS, window, refreshedAt),
  };
}
