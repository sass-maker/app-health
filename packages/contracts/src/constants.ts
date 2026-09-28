// V0 field bounds, time windows, and deterministic health thresholds.
// These constants are the single source of truth for both TypeScript and Go
// implementations. The Go module mirrors them in packages/go/contracts.go.

export const SCHEMA_VERSION = 'v1' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** Maximum events accepted in a single batch. */
export const MAX_BATCH_EVENTS = 1000;

/** Maximum length of an HTTP method string. */
export const MAX_METHOD_LENGTH = 16;

/** Maximum length of a normalized route template. */
export const MAX_ROUTE_LENGTH = 256;

/** Maximum length of an optional release tag. */
export const MAX_RELEASE_LENGTH = 128;

/** Maximum length of a normalized deployment environment label. */
export const MAX_ENVIRONMENT_LENGTH = 64;

/** Maximum accepted request duration in milliseconds (10 minutes). */
export const MAX_DURATION_MS = 600_000;

/** Maximum accepted response payload size in bytes (256 MiB). */
export const MAX_RESPONSE_BYTES = 268_435_456;

/** Maximum clock skew between SDK timestamp and ingest server time, in ms. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Minimum status code accepted as a valid HTTP response. */
export const MIN_STATUS_CODE = 100;
/** Maximum status code accepted as a valid HTTP response. */
export const MAX_STATUS_CODE = 599;

/** Requests below this count in a window are labelled insufficient-data. */
export const INSUFFICIENT_DATA_MIN_REQUESTS = 20;

/** Error rate at or above this fraction is unhealthy. */
export const UNHEALTHY_ERROR_RATE = 0.05;
/** p95 latency at or above this many ms is unhealthy. */
export const UNHEALTHY_P95_MS = 2000;
/** Error rate at or above this fraction is degraded. */
export const DEGRADED_ERROR_RATE = 0.01;
/** p95 latency at or above this many ms is degraded. */
export const DEGRADED_P95_MS = 1000;

/** V1 bounds retained to decode already-persisted endpoint aggregates. */
export const LEGACY_LATENCY_BUCKET_BOUNDS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000,
] as const;

/**
 * V2 keeps the histogram size fixed while separating integer durations below
 * 2 seconds from durations at or above 2 seconds. The 2000ms bound is replaced
 * by 1999ms; the next bucket's lower bound is therefore exactly 2000ms.
 */
export const LATENCY_BUCKET_BOUNDS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 1999, 4000, 8000, 16000, 32000, 64000,
] as const;

export const LATENCY_HISTOGRAM_SCHEMA_V2 = 'latency-v2' as const;
export type LatencyHistogramSchema = 'legacy-v1' | typeof LATENCY_HISTOGRAM_SCHEMA_V2;

/** Resolve the persisted D1 bounds identity without ever merging unknown bins. */
export function latencyHistogramSchemaFromBounds(bounds: string): LatencyHistogramSchema {
  if (bounds === JSON.stringify(LATENCY_BUCKET_BOUNDS_MS)) return LATENCY_HISTOGRAM_SCHEMA_V2;
  if (bounds === JSON.stringify(LEGACY_LATENCY_BUCKET_BOUNDS_MS)) return 'legacy-v1';
  throw new Error('Unsupported endpoint histogram schema');
}

/**
 * Normalize legacy V1 bins to the current layout conservatively. V1's (1000,
 * 2000] bucket straddles the 2000ms health threshold, so its entire count is
 * placed in V2's >=2000ms bucket. This can retain an old unhealthy warning,
 * but cannot silently convert ambiguous history to healthy.
 */
export function normalizeLatencyHistogram(
  histogram: readonly number[],
  schema: LatencyHistogramSchema,
): number[] {
  if (histogram.length !== LATENCY_BUCKET_BOUNDS_MS.length + 1)
    throw new Error('Invalid endpoint histogram shape');
  const normalized = new Array<number>(LATENCY_BUCKET_BOUNDS_MS.length + 1).fill(0);
  histogram.forEach((count, index) => {
    normalized[normalizeLatencyHistogramIndex(index, schema)] += count;
  });
  return normalized;
}

export function normalizeLatencyHistogramIndex(
  index: number,
  schema: LatencyHistogramSchema,
): number {
  if (!Number.isInteger(index) || index < 0 || index > LATENCY_BUCKET_BOUNDS_MS.length)
    throw new Error('Invalid endpoint histogram index');
  return schema === 'legacy-v1' && index === 9 ? 10 : index;
}

/** Supported query windows. */
export const WINDOWS = ['15m', '1h', '24h'] as const;
export type Window = (typeof WINDOWS)[number];

/** Window length in milliseconds. */
export const WINDOW_MS: Record<Window, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/** One-minute aggregate bucket length in milliseconds. */
export const BUCKET_MS = 60 * 1000;

/** Supported SDK runtimes reported for installation verification. */
export const RUNTIMES = ['node', 'worker', 'go', 'otel'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const HEALTH_STATES = ['healthy', 'degraded', 'unhealthy', 'insufficient-data'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const INSTALLATION_STATES = ['waiting', 'connected', 'stale', 'revoked', 'error'] as const;
export type InstallationState = (typeof INSTALLATION_STATES)[number];
