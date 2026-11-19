import {
  engagementCounter,
  sameEngagementCount,
  foldEngagement,
  type EngagementCount,
  type EngagementQueryRow,
} from './browser-engagement-plan.js';

export type OptionalEngagementTimings = {
  analyticsEngagementExitsMs?: number;
  analyticsOptionalAttempts?: number;
  analyticsOptionalFallbacks?: number;
};
type Results = PromiseSettledResult<EngagementQueryRow[]>[];
type Input = {
  load: (signal: AbortSignal) => Promise<Response>;
  original: (signal: AbortSignal) => Promise<Results>;
  duration: number;
  timings?: OptionalEngagementTimings;
};
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
function discard(body: ReadableStream<Uint8Array> | null) {
  if (body) void body.cancel().catch(() => {});
}
async function readData(input: Input, signal: AbortSignal) {
  const pending = input.load(signal);
  void pending.then(
    (response) => {
      if (signal.aborted) discard(response.body);
    },
    () => {},
  );
  const response = await abortable(pending, signal);
  if (!response.ok || !response.body) {
    discard(response.body);
    throw new Error('Engagement unavailable');
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0,
    complete = false;
  try {
    for (;;) {
      const next = await abortable(reader.read(), signal);
      if (next.done) {
        complete = true;
        break;
      }
      size += next.value.byteLength;
      if (size > 1024 * 1024) throw new Error('Engagement byte cap');
      chunks.push(next.value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  return body && typeof body === 'object' && 'data' in body ? body.data : undefined;
}
export function startOptionalEngagement(input: Input) {
  const controller = new AbortController(),
    originals = new AbortController();
  let fallback: Promise<Results> | undefined,
    cancelled = false,
    controlFailure = false;
  let resolveControls!: (value: Promise<EngagementCount>) => void;
  let resolveFallback!: (value: Promise<Results>) => void;
  const controls = new Promise<EngagementCount>((resolve) => {
    resolveControls = resolve;
  });
  const decided = new Promise<Results>((resolve) => {
    resolveFallback = resolve;
  });
  const started = performance.now();
  const deadline = started + 1000;
  const original = () => {
    if (cancelled) throw controller.signal.reason;
    if (!fallback) {
      if (input.timings) input.timings.analyticsOptionalFallbacks = 1;
      controller.abort(new DOMException('Original optional queries selected', 'AbortError'));
      clearTimeout(watchdog);
      fallback = input.original(originals.signal);
      resolveFallback(fallback);
    }
    return fallback;
  };
  const watchdog = setTimeout(() => {
    try {
      original();
    } catch {
      /* Cancellation already rejects the candidate. */
    }
  }, 1000);
  if (input.timings) input.timings.analyticsOptionalAttempts = 1;
  const data = readData(input, controller.signal).finally(() => {
    if (input.timings) input.timings.analyticsEngagementExitsMs = performance.now() - started;
  });
  const candidate = Promise.all([data, controls])
    .then(([data, count]) => {
      if (fallback || performance.now() >= deadline) return original();
      const rows = foldEngagement(data, count, input.duration);
      return Promise.allSettled(rows.map((value) => Promise.resolve(value)));
    })
    .catch((error) => {
      if (cancelled || controlFailure) throw error;
      return original();
    });
  const result = Promise.race([candidate, decided]).finally(() => {
    clearTimeout(watchdog);
  });
  return {
    result,
    controls: (trend: Promise<readonly unknown[]>, periods: Promise<readonly unknown[]>) => {
      const counts: Array<EngagementCount | undefined> = [];
      const watch = (pending: Promise<readonly unknown[]>, current: boolean) =>
        pending.then((rows) => {
          const value = engagementCounter(rows, current);
          counts[current ? 1 : 0] = value;
          if (!value || (counts[0] && counts[1] && !sameEngagementCount(counts[0], counts[1])))
            original();
          return value;
        });
      resolveControls(
        Promise.all([watch(trend, false), watch(periods, true)])
          .then(([left, right]) => {
            if (!left || !right || !sameEngagementCount(left, right))
              throw new Error('Uncertain engagement controls');
            return left;
          })
          .catch((error) => {
            controlFailure = !fallback;
            controller.abort(error);
            throw error;
          }),
      );
    },
    cancel: (error: unknown) => {
      cancelled = true;
      controller.abort(error);
      originals.abort(error);
      clearTimeout(watchdog);
    },
  };
}
