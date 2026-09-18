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

/** Fixed latency histogram bucket upper bounds in milliseconds. */
export const LATENCY_BUCKET_BOUNDS_MS = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000,
] as const;

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
