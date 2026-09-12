// @saas-maker/app-health/web — browser log client.
// This entrypoint only imports browser-safe contracts and log normalisation.

import {
  PUBLIC_LOG_KEY_PREFIX,
  SCHEMA_VERSION,
  type BrowserLogBatchV1,
  type LogEventV1,
} from './contracts.js';
import { buildLogEventV1, type LogInput } from './log.js';

export type { LogInput } from './log.js';

export interface WebLifecycle {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
  visibilityState(): string;
}

export interface WebLoggerOptions {
  publicKey: string;
  endpoint?: string;
  environment?: string;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  maxBatchSize?: number;
  fetch?: (
    url: string,
    init: RequestInit,
  ) => Promise<{ ok: boolean; status?: number; body?: { cancel(): Promise<unknown> } | null }>;
  sendBeacon?: (url: string, body: string) => boolean;
  lifecycle?: WebLifecycle | false;
  now?: () => number;
  randomUUID?: () => string;
  disableTimer?: boolean;
}

export interface WebLoggerDiagnostics {
  queued: number;
  sent: number;
  dropped: number;
  retried: number;
  beaconQueued: number;
}

export interface WebLogger {
  log(event: string, input?: LogInput): void;
  flush(): Promise<void>;
  flushBeacon(): boolean;
  diagnostics(): WebLoggerDiagnostics;
  close(): Promise<void>;
}

const DEFAULT_ENDPOINT = 'https://ingest.sassmaker.com/v1/logs';
const MAX_BATCH_BYTES = 60 * 1024;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 2000;

interface BrowserGlobals {
  document?: {
    visibilityState: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  window?: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  navigator?: { sendBeacon?: (url: string, data: Blob) => boolean };
}
const browser = globalThis as unknown as BrowserGlobals;

function browserLifecycle(): WebLifecycle | false {
  const { document, window } = browser;
  if (!document || !window || typeof document.addEventListener !== 'function') return false;
  return {
    addEventListener: (type, listener) => {
      if (type === 'visibilitychange') document.addEventListener?.(type, listener);
      else window.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      if (type === 'visibilitychange') document.removeEventListener?.(type, listener);
      else window.removeEventListener?.(type, listener);
    },
    visibilityState: () => document.visibilityState,
  };
}

function defaultBeacon(url: string, body: string): boolean {
  const send = browser.navigator?.sendBeacon;
  if (typeof send !== 'function') return false;
  return send.call(browser.navigator, url, new Blob([body], { type: 'text/plain' }));
}

function uuidV4(): string {
  return crypto.randomUUID();
}

interface ResolvedWebOptions {
  publicKey: string;
  endpoint: string;
  environment: string | undefined;
  maxQueueSize: number;
  maxBatchSize: number;
  flushIntervalMs: number;
  disableTimer: boolean;
  now: () => number;
  uuid: () => string;
  fetchFn: NonNullable<WebLoggerOptions['fetch']>;
  beacon: NonNullable<WebLoggerOptions['sendBeacon']>;
  lifecycle: WebLifecycle | false;
}

const WEB_DEFAULTS = {
  endpoint: DEFAULT_ENDPOINT,
  maxQueueSize: 200,
  maxBatchSize: 50,
  flushIntervalMs: 2000,
  disableTimer: false,
  now: () => Date.now(),
  randomUUID: uuidV4,
  fetch: async (url: string, init: RequestInit) => {
    return fetch(url, init);
  },
  sendBeacon: defaultBeacon,
};
type MergedWebOptions = WebLoggerOptions & {
  endpoint: string;
  maxQueueSize: number;
  maxBatchSize: number;
  flushIntervalMs: number;
  disableTimer: boolean;
  now: () => number;
  randomUUID: () => string;
  fetch: NonNullable<WebLoggerOptions['fetch']>;
  sendBeacon: NonNullable<WebLoggerOptions['sendBeacon']>;
};

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function serializedBytes(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function safeEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function validateLimits(merged: MergedWebOptions): void {
  if (!boundedNumber(merged.maxQueueSize, 1, 10_000))
    throw new Error('maxQueueSize must be an integer from 1 to 10000');
  if (!boundedNumber(merged.maxBatchSize, 1, 100))
    throw new Error('maxBatchSize must be an integer from 1 to 100');
  if (!boundedNumber(merged.flushIntervalMs, 0, 86_400_000))
    throw new Error('flushIntervalMs must be an integer from 0 to 86400000');
}

function validateTypes(merged: MergedWebOptions): void {
  if (
    typeof merged.disableTimer !== 'boolean' ||
    typeof merged.fetch !== 'function' ||
    typeof merged.sendBeacon !== 'function'
  ) {
    throw new Error('@saas-maker/app-health/web: invalid option type');
  }
  if (typeof merged.now !== 'function' || typeof merged.randomUUID !== 'function')
    throw new Error('clock and randomUUID must be functions');
}

function validateLifecycle(lifecycle: WebLifecycle | false | undefined): void {
  if (
    lifecycle !== undefined &&
    lifecycle !== false &&
    (typeof lifecycle.addEventListener !== 'function' ||
      typeof lifecycle.visibilityState !== 'function')
  ) {
    throw new Error('lifecycle must provide addEventListener and visibilityState');
  }
}

function validateWebOptions(merged: MergedWebOptions): void {
  if (!safeEndpoint(merged.endpoint)) throw new Error('endpoint must be a safe HTTP(S) URL');
  validateLimits(merged);
  validateTypes(merged);
  if (
    merged.environment !== undefined &&
    (typeof merged.environment !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(merged.environment))
  ) {
    throw new Error('environment must be a string of at most 64 characters');
  }
  validateLifecycle(merged.lifecycle);
}

function resolveWebOptions(options: WebLoggerOptions): ResolvedWebOptions {
  if (
    !options ||
    typeof options.publicKey !== 'string' ||
    options.publicKey.length > 256 ||
    !options.publicKey.startsWith(PUBLIC_LOG_KEY_PREFIX)
  ) {
    throw new Error(
      `@saas-maker/app-health/web: publicKey must start with ${PUBLIC_LOG_KEY_PREFIX}`,
    );
  }
  const provided = Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  );
  const merged = { ...WEB_DEFAULTS, ...provided, publicKey: options.publicKey } as MergedWebOptions;
  validateWebOptions(merged);
  return {
    publicKey: merged.publicKey,
    endpoint: merged.endpoint,
    environment: merged.environment,
    maxQueueSize: merged.maxQueueSize,
    maxBatchSize: merged.maxBatchSize,
    flushIntervalMs: merged.flushIntervalMs,
    disableTimer: merged.disableTimer,
    now: merged.now,
    uuid: merged.randomUUID,
    fetchFn: merged.fetch,
    beacon: merged.sendBeacon,
    lifecycle: merged.lifecycle === undefined ? browserLifecycle() : merged.lifecycle,
  };
}

interface Batch {
  logs: LogEventV1[];
  body: string;
}

function attachLifecycle(lifecycle: WebLifecycle | false, flushBeacon: () => boolean): () => void {
  if (!lifecycle) return () => undefined;
  const onPageHide = () => void flushBeacon();
  const onVisibility = () => {
    if (lifecycle.visibilityState() === 'hidden') flushBeacon();
  };
  lifecycle.addEventListener('pagehide', onPageHide);
  lifecycle.addEventListener('visibilitychange', onVisibility);
  return () => {
    lifecycle.removeEventListener?.('pagehide', onPageHide);
    lifecycle.removeEventListener?.('visibilitychange', onVisibility);
  };
}

class BrowserLogger implements WebLogger {
  private readonly queue: LogEventV1[] = [];
  private readonly beaconBatches: Batch[] = [];
  private readonly diag: WebLoggerDiagnostics = {
    queued: 0,
    sent: 0,
    dropped: 0,
    retried: 0,
    beaconQueued: 0,
  };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;
  private inflightCount = 0;
  private closing: Promise<void> | null = null;
  private readonly detach: () => void;

  constructor(private readonly cfg: ResolvedWebOptions) {
    this.detach = attachLifecycle(cfg.lifecycle, () => this.flushBeacon());
  }

  private makeBatch(logs: LogEventV1[], id = this.cfg.uuid()): Batch {
    const batch: BrowserLogBatchV1 = {
      public_key: this.cfg.publicKey,
      batch_id: id,
      schema_version: SCHEMA_VERSION,
      ...(this.cfg.environment !== undefined ? { environment: this.cfg.environment } : {}),
      logs,
    };
    return { logs, body: JSON.stringify(batch) };
  }

  private takeBatch(): Batch | null {
    const logs: LogEventV1[] = [];
    const id = this.cfg.uuid();
    let bytes = serializedBytes(this.makeBatch([], id).body);
    while (logs.length < this.cfg.maxBatchSize && this.queue.length > 0) {
      const size = serializedBytes(JSON.stringify(this.queue[0])) + (logs.length ? 1 : 0);
      if (bytes + size > MAX_BATCH_BYTES) {
        if (logs.length) break;
        this.queue.shift();
        this.diag.dropped++;
        continue;
      }
      bytes += size;
      logs.push(this.queue.shift() as LogEventV1);
    }
    return logs.length ? this.makeBatch(logs, id) : null;
  }

  private settle(batch: Batch, accepted: boolean): void {
    if (accepted) this.diag.sent += batch.logs.length;
    else this.diag.dropped += batch.logs.length;
  }

  private async request(batch: Batch): Promise<boolean> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const fetchPromise = this.cfg.fetchFn(this.cfg.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: batch.body,
          keepalive: true,
          credentials: 'omit',
          signal: controller.signal,
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('request timeout'));
          }, REQUEST_TIMEOUT_MS);
        });
        const response = await Promise.race([fetchPromise, timeoutPromise]);
        void response.body?.cancel().catch(() => {});
        if (response.ok) return true;
        if (!(response.status === 429 || (response.status !== undefined && response.status >= 500)))
          return false;
      } catch {
        // Network and timeout errors are retryable.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (attempt < MAX_ATTEMPTS) {
        this.diag.retried += 1;
        await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      }
    }
    return false;
  }

  private async runFlush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const work = this.beaconBatches.splice(0);
    this.diag.beaconQueued = 0;
    while (this.queue.length) {
      const batch = this.takeBatch();
      if (batch) work.push(batch);
    }
    this.inflightCount = work.reduce((total, batch) => total + batch.logs.length, 0);
    for (const batch of work) {
      this.settle(batch, await this.request(batch));
      this.inflightCount -= batch.logs.length;
    }
  }

  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runFlush().finally(() => {
      this.inflight = null;
      this.diag.queued = this.queue.length;
      if (this.queue.length > 0 && !this.closed && !this.cfg.disableTimer && this.timer === null) {
        this.timer = setTimeout(() => void this.flush(), this.cfg.flushIntervalMs);
      }
    });
    return this.inflight;
  }

  flushBeacon(): boolean {
    if (this.closed || this.queue.length === 0) return this.queue.length === 0;
    const batch = this.takeBatch();
    if (!batch) return false;
    let accepted = false;
    try {
      accepted = this.cfg.beacon(this.cfg.endpoint, batch.body);
    } catch {
      accepted = false;
    }
    if (accepted) {
      this.beaconBatches.push(batch);
      this.diag.beaconQueued += batch.logs.length;
    } else this.settle(batch, false);
    return accepted;
  }

  log(event: string, input: LogInput = {}): void {
    if (this.closed) return;
    try {
      const entry = buildLogEventV1(event, input, { now: this.cfg.now, uuid: this.cfg.uuid });
      if (
        entry === null ||
        this.queue.length + this.diag.beaconQueued + this.inflightCount >= this.cfg.maxQueueSize
      ) {
        this.diag.dropped += 1;
        return;
      }
      this.queue.push(entry);
      this.diag.queued = this.queue.length;
      if (this.queue.length >= this.cfg.maxBatchSize) void this.flush();
      else if (!this.cfg.disableTimer && this.timer === null)
        this.timer = setTimeout(() => void this.flush(), this.cfg.flushIntervalMs);
    } catch {
      this.diag.dropped += 1;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.detach();
    this.closing = this.flush().then(async () => {
      if (this.queue.length || this.beaconBatches.length) await this.flush();
    });
    return this.closing;
  }

  diagnostics(): WebLoggerDiagnostics {
    return {
      ...this.diag,
      queued: this.queue.length + this.diag.beaconQueued + this.inflightCount,
    };
  }
}

export function createWebLogger(options: WebLoggerOptions): WebLogger {
  return new BrowserLogger(resolveWebOptions(options));
}
