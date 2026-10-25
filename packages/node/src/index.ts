// @saas-maker/app-health — Node SDK for endpoint health.
//
// Public surface:
//   - createAppHealthClient(options): bounded async batching client.
//   - normalize* helpers and V1 contract re-exports.
//
// Privacy: endpoint telemetry carries only method, normalized route template,
// status, duration, timestamp, and optional release. No headers, cookies,
// query values, route parameter values, bodies, identity, stacks, or spans are
// ever derived from requests. Application logs (`client.log()`) are separate,
// explicit, owner-authored events and carry exactly what the caller passes.

export { createAppHealthClient } from './client.js';
export type { AppHealthClient, AppHealthClientOptions, EventInput } from './client.js';
export type { LogInput } from './log.js';
export { sendBatch } from './transport.js';
export type { TransportOptions, TransportResult, FetchLike } from './transport.js';
export {
  normalizeMethod,
  normalizeRoutePath,
  normalizeStatus,
  normalizeDuration,
  normalizeRelease,
  normalizeTimestamp,
} from './normalize.js';
export { randomUUID } from './uuid.js';
export type { AppHealthDiagnostics } from './diagnostics.js';

export type {
  EventV1,
  EventBatchV1,
  LogBatchV1,
  LogEventV1,
  LogLevel,
  LogPropValue,
  RuntimeField,
  SchemaVersion,
} from './contracts.js';
export {
  SCHEMA_VERSION,
  MAX_BATCH_EVENTS,
  MAX_DURATION_MS,
  MAX_ROUTE_LENGTH,
  MAX_METHOD_LENGTH,
  MAX_RELEASE_LENGTH,
  MIN_STATUS_CODE,
  MAX_STATUS_CODE,
  LOG_LEVELS,
  MAX_LOG_BATCH,
  MAX_LOG_PROPS,
} from './contracts.js';

export type { ProductTrackInput, ProductMoney } from './product.js';
