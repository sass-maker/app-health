import { browserQuery } from './browser-query.js';
import type { QueryOptions, QueryRow } from './browser-report-query-types.js';

const MAX_JOINT_BYTES = 1024 * 1024;
export function assertProviderDeadline(options: QueryOptions) {
  options.signal?.throwIfAborted();
  if (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt)
    throw new DOMException('Analytics deadline elapsed', 'TimeoutError');
}
export async function queryReportRows(sql: string, options: QueryOptions): Promise<QueryRow[]> {
  assertProviderDeadline(options);
  const response = await browserQuery(sql, options);
  if (!response.ok) throw new Error('event reports unavailable');
  const body = (await response.json()) as { data: QueryRow[] };
  assertProviderDeadline(options);
  if (!Array.isArray(body.data) || body.data.length > 100)
    throw new Error('invalid analytical response');
  return body.data;
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
function discard(body: ReadableStream<Uint8Array> | null) {
  if (body) void body.cancel().catch(() => {});
}
async function boundedJointJson(response: Response, signal: AbortSignal, options: QueryOptions) {
  if (!response.body) throw new Error('Missing joint body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      assertProviderDeadline(options);
      const next = await abortable(reader.read(), signal);
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_JOINT_BYTES) throw new Error('Joint response byte cap');
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  assertProviderDeadline(options);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  assertProviderDeadline(options);
  return body && typeof body === 'object' && 'data' in body ? body.data : undefined;
}
/** A failed speculative read falls back to originals within the same report deadline. */
export async function queryJointRows(
  sql: string,
  options: QueryOptions,
  controller: AbortController,
) {
  const started = performance.now();
  if (options.timings) options.timings.analyticsJointAttempts = 1;
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  try {
    assertProviderDeadline(options);
    const pending = browserQuery(sql, { ...options, signal });
    // A late response from an abort-ignoring transport must not retain its body.
    void pending.then(
      (response) => {
        if (signal.aborted) discard(response.body);
      },
      () => {},
    );
    const response = await abortable(pending, signal);
    if (!response.ok) {
      discard(response.body);
      return undefined;
    }
    return await boundedJointJson(response, signal, options);
  } catch {
    assertProviderDeadline(options);
    return undefined;
  } finally {
    if (options.timings) options.timings.analyticsJointMs = performance.now() - started;
  }
}
