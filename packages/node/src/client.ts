// @saas-maker/app-health client: bounded async batching, short timeouts, bounded
// retries, queue-pressure drops, graceful flush/close, and local diagnostics.
//
// The client never blocks the application response path. `record()` is
// synchronous, non-blocking, and drops on queue pressure. Delivery happens on
// a timer or size threshold and during `flush()`/`close()`. The application
// response never awaits ingest.

import {
  MAX_BATCH_EVENTS,
  MAX_LOG_BATCH,
  SCHEMA_VERSION,
  type EventBatchV1,
  type EventV1,
  type LogBatchV1,
  type LogEventV1,
  type RuntimeField,
} from './contracts.js';
import { buildLogEventV1, deriveLogsEndpoint, type LogInput } from './log.js';
import { createDiagnostics, type AppHealthDiagnostics } from './diagnostics.js';
import {
  normalizeDuration,
  normalizeMethod,
  normalizeRelease,
  normalizeRoutePath,
  normalizeStatus,
  normalizeTimestamp,
} from './normalize.js';
import {
  sendBatch,
  type FetchLike,
  type TransportOptions,
  type TransportResult,
} from './transport.js';
import { randomUUID } from './uuid.js';
import { takeSizedBatch } from './batch-size.js';
import { observe } from './observe.js';

/** Input accepted by `record()`. Only endpoint-summary fields are permitted. */
export interface EventInput {
  method: unknown;
  route: unknown;
  status_code: unknown;
  duration_ms: unknown;
  /** Optional; defaults to the client's configured release. */
  release?: unknown;
  /** Optional; defaults to the current time. */
  timestamp?: unknown;
}

export interface AppHealthClientOptions {
  /** Ingest key scoped to one product. */
  key: string;
  /** Deployment environment routed beneath the authenticated product. */
  environment?: string;
  /** Absolute ingest URL, e.g. http://localhost:8787/v1/ingest. */
  endpoint: string;
  /** Absolute logs URL. Defaults to `endpoint` with `/v1/ingest` replaced by `/v1/logs`. */
  logsEndpoint?: string;
  /** Optional release tag applied to every event unless overridden. */
  release?: string;
  /** JavaScript runtime sending the batch. Defaults to `node`. */
  runtime?: 'node' | 'worker';
  /** Maximum events buffered in memory before dropping. Default 10_000. */
  maxQueueSize?: number;
  /** Events per batch. Default 100 (must be <= MAX_BATCH_EVENTS). */
  maxBatchSize?: number;
  /** Auto-flush interval in ms. Default 5_000. */
  flushIntervalMs?: number;
  /** Per-request timeout in ms. Default 2_000. */
  requestTimeoutMs?: number;
  /** Maximum retry attempts per batch. Default 3. */
  maxRetries?: number;
  /** Base retry backoff in ms. Default 100. */
  retryBackoffMs?: number;
  /** Inject a fetch implementation for tests. */
  fetch?: FetchLike;
  /** Inject a clock for tests. */
  now?: () => number;
  /** Inject a UUID generator for tests. */
  randomUUID?: () => string;
  /** Disable the auto-flush timer (useful for tests). */
  disableTimer?: boolean;
}

export interface AppHealthClient {
  /** Queue one endpoint summary. Non-blocking; drops on overflow. */
  record(event: EventInput): void;
  /**
   * Queue one application log ("signup", "waitlist.join", "payment.failed").
   * Non-blocking; invalid input is dropped and counted. Logs share the queue
   * bound and flush cycle with endpoint events but travel to `/v1/logs`.
   */
  log(event: string, input?: LogInput): void;
  /** Flush all queued events with retries. Resolves when the drain completes. */
  flush(): Promise<void>;
  /** Stop the timer, flush remaining events, and resolve. */
  close(): Promise<void>;
  /** Read-only diagnostic counters. */
  diagnostics(): AppHealthDiagnostics;
}

const DEFAULTS = {
  maxQueueSize: 10_000,
  maxBatchSize: 100,
  flushIntervalMs: 5_000,
  requestTimeoutMs: 2_000,
  maxRetries: 3,
  retryBackoffMs: 100,
} as const;

type ResolvedClientConfig = {
  endpointUrl: string;
  logsEndpointUrl: string;
  maxQueueSize: number;
  maxBatchSize: number;
  logBatchSize: number;
  flushIntervalMs: number;
  transport: Omit<TransportOptions, 'endpoint'>;
  now: () => number;
  uuid: () => string;
  defaultRelease: string | undefined;
  environment: string | undefined;
  runtime: 'node' | 'worker';
};

function resolveClientConfig(options: AppHealthClientOptions): ResolvedClientConfig {
  if (typeof options?.key !== 'string' || options.key.length === 0) {
    throw new Error('@saas-maker/app-health: createAppHealthClient requires a non-empty `key`');
  }
  const endpoint = parseEndpoint(options?.endpoint);
  if (endpoint === null) {
    throw new Error('@saas-maker/app-health: createAppHealthClient requires an http(s) `endpoint`');
  }
  const logsEndpoint =
    options.logsEndpoint === undefined
      ? deriveLogsEndpoint(endpoint)
      : parseEndpoint(options.logsEndpoint);
  if (logsEndpoint === null) {
    throw new Error('@saas-maker/app-health: logsEndpoint must be an http(s) URL');
  }
  const runtime = options.runtime ?? 'node';
  if (runtime !== 'node' && runtime !== 'worker') {
    throw new Error('@saas-maker/app-health: runtime must be `node` or `worker`');
  }
  const opts = { ...DEFAULTS, ...options };
  const maxBatchSize = boundedInteger('maxBatchSize', opts.maxBatchSize, 1, MAX_BATCH_EVENTS);
  return {
    endpointUrl: endpoint,
    logsEndpointUrl: logsEndpoint,
    maxQueueSize: boundedInteger('maxQueueSize', opts.maxQueueSize, 1, 1_000_000),
    maxBatchSize,
    logBatchSize: Math.min(maxBatchSize, MAX_LOG_BATCH),
    flushIntervalMs: boundedInteger('flushIntervalMs', opts.flushIntervalMs, 1, 60 * 60 * 1000),
    transport: {
      key: options.key,
      requestTimeoutMs: boundedInteger('requestTimeoutMs', opts.requestTimeoutMs, 1, 60_000),
      maxRetries: boundedInteger('maxRetries', opts.maxRetries, 0, 10),
      retryBackoffMs: boundedInteger('retryBackoffMs', opts.retryBackoffMs, 0, 60_000),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
    now: options.now ?? (() => Date.now()),
    uuid: options.randomUUID ?? randomUUID,
    defaultRelease: normalizeRelease(options.release),
    environment: normalizeEnvironment(options.environment),
    runtime,
  };
}

interface ClientState {
  cfg: ResolvedClientConfig;
  queue: EventV1[];
  logQueue: LogEventV1[];
  diag: ReturnType<typeof createDiagnostics>;
}

async function drainQueues({ cfg, queue, logQueue, diag }: ClientState): Promise<void> {
  const send = async (batch: EventBatchV1 | LogBatchV1, endpoint: string, items: unknown[]) => {
    diag.setQueued(queue.length + logQueue.length);
    const result: TransportResult = await sendBatch(batch, { ...cfg.transport, endpoint });
    recordDeliveryResult(result, items, diag);
  };
  while (queue.length > 0) {
    const events = takeSizedBatch(queue, Math.min(cfg.maxBatchSize, 250));
    const batch = buildBatch(events, cfg.uuid, cfg.runtime, cfg.environment, cfg.defaultRelease);
    await send(batch, cfg.endpointUrl, events);
  }
  while (logQueue.length > 0) {
    const logs = takeSizedBatch(logQueue, cfg.logBatchSize);
    await send(buildLogBatch(logs, cfg.uuid, cfg.environment), cfg.logsEndpointUrl, logs);
  }
}

export function createAppHealthClient(options: AppHealthClientOptions): AppHealthClient {
  const cfg = resolveClientConfig(options);
  const state: ClientState = { cfg, queue: [], logQueue: [], diag: createDiagnostics() };
  const { queue, logQueue, diag } = state;
  const queued = () => queue.length + logQueue.length;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let flushing: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  function scheduleFlush(): void {
    if (options.disableTimer || closed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush()
        .catch(() => {
          /* errors are recorded in diagnostics */
        })
        .finally(() => {
          if (queued() > 0) scheduleFlush();
        });
    }, cfg.flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Shared admission path: invalid items and overflow are dropped and counted, never thrown. */
  function enqueue<T>(target: T[], item: T | null, batchSize: number): void {
    if (closed) return;
    if (item === null) return diag.increment('droppedInvalid');
    if (queued() >= cfg.maxQueueSize) return diag.increment('droppedOverflow');
    target.push(item);
    diag.setQueued(queued());
    scheduleFlush();
    if (target.length >= batchSize) {
      void flush().catch(() => {
        /* errors are recorded in diagnostics */
      });
    }
  }

  function flush(): Promise<void> {
    if (flushing) return flushing;
    if (queued() === 0) return Promise.resolve();
    // Coalesce concurrent flush calls into a single drain.
    const run =
      flushing ??
      drainQueues(state).finally(() => {
        flushing = null;
      });
    flushing = run;
    return run;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    closing = flush();
    return closing;
  }

  const { now, uuid, defaultRelease } = cfg;
  return {
    record: (event) =>
      enqueue(
        queue,
        observe(() => buildEventV1(event, { now, uuid, defaultRelease })) ?? null,
        cfg.maxBatchSize,
      ),
    log: (event, input = {}) =>
      enqueue(
        logQueue,
        observe(() => buildLogEventV1(event, input, { now, uuid })) ?? null,
        cfg.logBatchSize,
      ),
    flush,
    close,
    diagnostics: () => diag.snapshot(),
  };
}

function buildEventV1(
  event: EventInput,
  ctx: { now: () => number; uuid: () => string; defaultRelease: string | undefined },
): EventV1 | null {
  const method = normalizeMethod(event.method);
  const route = normalizeRoutePath(event.route);
  const status = normalizeStatus(event.status_code);
  const duration = normalizeDuration(event.duration_ms);
  if (method === null || route === null || status === null || duration === null) {
    return null;
  }
  const release = normalizeRelease(event.release) ?? ctx.defaultRelease;
  const timestamp = normalizeTimestamp(event.timestamp) ?? ctx.now();
  return {
    event_id: ctx.uuid(),
    timestamp,
    method,
    route,
    status_code: status,
    duration_ms: duration,
    ...(release !== undefined ? { release } : {}),
  };
}

function buildBatch(
  events: EventV1[],
  uuid: () => string,
  runtime: string,
  environment: string | undefined,
  defaultRelease: string | undefined,
): EventBatchV1 {
  return {
    batch_id: uuid(),
    schema_version: SCHEMA_VERSION,
    runtime: runtime as RuntimeField,
    ...(environment !== undefined ? { environment } : {}),
    ...(defaultRelease !== undefined ? { release: defaultRelease } : {}),
    events,
  };
}

function buildLogBatch(
  logs: LogEventV1[],
  uuid: () => string,
  environment: string | undefined,
): LogBatchV1 {
  return {
    batch_id: uuid(),
    schema_version: SCHEMA_VERSION,
    ...(environment !== undefined ? { environment } : {}),
    logs,
  };
}

function recordDeliveryResult(
  result: TransportResult,
  events: readonly unknown[],
  diag: ReturnType<typeof createDiagnostics>,
) {
  if (result.ok) {
    diag.increment('sentBatches');
    diag.increment('sentEvents', events.length);
    if (result.retried > 0) diag.increment('retriedBatches');
    diag.setLastError(null);
  } else {
    diag.increment('failedBatches');
    if (result.retried > 0) diag.increment('retriedBatches');
    // Transport-level retries are already exhausted. Drop the batch to keep
    // the queue bounded and the flush loop terminating; record the loss in
    // diagnostics. Requeuing would risk an unbounded loop on persistent
    // outages and would defeat the fail-open guarantee.
    diag.increment('droppedDelivery', events.length);
    diag.setLastError(result.error);
  }
}

function normalizeEnvironment(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('@saas-maker/app-health: environment must be a lower-case slug');
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(normalized)) {
    throw new Error('@saas-maker/app-health: environment must be a lower-case slug');
  }
  return normalized;
}

function parseEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`@saas-maker/app-health: ${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
