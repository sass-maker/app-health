// Distribution-safe subset of the V1 ingest contract used by the Node SDK.
// Keep these values aligned with packages/contracts/src/constants.ts; the
// parity test fails if the canonical contract changes without the SDK.

export const SCHEMA_VERSION = 'v1' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const MAX_BATCH_EVENTS = 1000;
export const MAX_METHOD_LENGTH = 16;
export const MAX_ROUTE_LENGTH = 256;
export const MAX_RELEASE_LENGTH = 128;
export const MAX_DURATION_MS = 600_000;
export const MAX_RESPONSE_BYTES = 268_435_456;
export const MIN_STATUS_CODE = 100;
export const MAX_STATUS_CODE = 599;

export type RuntimeField = 'node' | 'worker' | 'go' | 'otel';

export interface EventV1 {
  event_id: string;
  timestamp: number;
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
  response_bytes?: number;
  release?: string;
}

export interface EventBatchV1 {
  batch_id: string;
  schema_version: SchemaVersion;
  runtime: RuntimeField;
  environment?: string;
  release?: string;
  events: EventV1[];
}

// Application logs (owner-authored events). Mirrors packages/contracts/src/log.ts;
// the parity test fails if the canonical bounds change without this table.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_EVENT_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
export const LOG_BOUNDS = {
  batch: 100,
  event: 64,
  title: 200,
  description: 2000,
  icon: 16,
  props: 40,
  propKey: 64,
  propValue: 500,
} as const;
export const MAX_LOG_BATCH = LOG_BOUNDS.batch;
export const MAX_LOG_PROPS = LOG_BOUNDS.props;
/** Browser (public) log keys carry this prefix and travel in the request body. */
export const PUBLIC_LOG_KEY_PREFIX = 'ahk_pub_';

export type LogPropValue = string | number | boolean | null;

export interface LogEventV1 {
  log_id: string;
  timestamp: number;
  event: string;
  level: LogLevel;
  title?: string;
  description?: string;
  icon?: string;
  props: Record<string, LogPropValue>;
}

export interface LogBatchV1 {
  batch_id: string;
  schema_version: SchemaVersion;
  environment?: string;
  logs: LogEventV1[];
}

/** Browser batch: LogBatchV1 plus the public key, sent as text/plain to avoid a CORS preflight. */
export interface BrowserLogBatchV1 extends LogBatchV1 {
  public_key: string;
}
