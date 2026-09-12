// HTTP transport for the V1 ingest contract.
//
// Uses the Node 20+ built-in `fetch` and `AbortController`. The ingest key is
// sent as a bearer token. Only the serialized V1 batch is sent; no request
// content is referenced. Timeouts are enforced via AbortController. Retries
// are bounded with exponential backoff and only applied to transient errors
// (network failures, 5xx, 429). Non-retryable 4xx responses fail fast.

import type { EventBatchV1, LogBatchV1 } from './contracts.js';

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<{
  status: number;
  body?: { cancel(): Promise<unknown> } | null;
}>;

export interface TransportOptions {
  endpoint: string;
  key: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  fetch?: FetchLike;
  /** Inject a sleep function for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export type TransportResult =
  | { ok: true; status: number; retried: number }
  | { ok: false; status?: number; retried: number; error: string };

/**
 * Send one batch to the ingest endpoint with bounded retries.
 * Returns a structured result; never throws.
 */
export async function sendBatch(
  batch: EventBatchV1 | LogBatchV1,
  options: TransportOptions,
): Promise<TransportResult> {
  const fetchFn = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const body = JSON.stringify(batch);
  let lastError = 'unknown error';
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchFn(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.key}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
      lastStatus = undefined;
      if (attempt < options.maxRetries) {
        await sleep(backoffMs(options.retryBackoffMs, attempt));
        continue;
      }
      return { ok: false, retried: attempt, error: lastError };
    }
    clearTimeout(timer);
    void response.body?.cancel().catch(() => {});
    lastStatus = response.status;
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status, retried: attempt };
    }
    if (isRetryableStatus(response.status) && attempt < options.maxRetries) {
      lastError = `ingest responded ${response.status}`;
      await sleep(backoffMs(options.retryBackoffMs, attempt));
      continue;
    }
    return {
      ok: false,
      status: response.status,
      retried: attempt,
      error: `ingest responded ${response.status}`,
    };
  }
  return { ok: false, status: lastStatus, retried: options.maxRetries, error: lastError };
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function backoffMs(base: number, attempt: number): number {
  // Exponential backoff with a small jitter-free factor; capped at 8x base.
  const factor = Math.min(2 ** attempt, 8);
  return base * factor;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
