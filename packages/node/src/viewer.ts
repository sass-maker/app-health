import { parseSharedAnalytics, type SharedAnalytics } from '../../contracts/src/sharing.js';
export type { SharedAnalytics } from '../../contracts/src/sharing.js';

export type ViewerState =
  | { kind: 'loading' | 'paused' | 'closed' }
  | { kind: 'ready'; data: SharedAnalytics }
  | { kind: 'unavailable'; reason: 'revoked' | 'temporary' };
export interface ViewerVisibility {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
export interface AnalyticsViewerOptions {
  /** Dashboard origin, not the ingestion endpoint. */
  origin: string;
  /** Revocable ahs_ share token, never an ingestion or owner key. */
  token: string;
  fetch?: typeof globalThis.fetch;
  /** Defaults to document in browsers; null disables visibility integration. */
  visibility?: ViewerVisibility | null;
}
export class AnalyticsViewerError extends Error {
  constructor(public readonly reason: 'revoked' | 'temporary' | 'closed' | 'aborted') {
    super(`Public analytics ${reason}`);
    this.name = 'AnalyticsViewerError';
  }
}
type Listener = (state: ViewerState) => void;
function viewerOptions(options: AnalyticsViewerOptions) {
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !/^ahs_[A-Za-z0-9_-]{43}$/.test(options.token)
  )
    throw new TypeError('A dashboard origin and revocable analytics share token are required');
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetcher !== 'function') throw new TypeError('fetch is required');
  const document = (globalThis as typeof globalThis & { document?: ViewerVisibility }).document;
  return {
    endpoint: `${origin.origin}/v1/shared/analytics`,
    fetcher,
    visibility: options.visibility === undefined ? document : options.visibility,
  };
}

/** One shared read/poll loop per client. No telemetry writes or persistent cache. */
export function createAnalyticsViewer(options: AnalyticsViewerOptions) {
  return new AnalyticsViewer(options);
}
class AnalyticsViewer {
  private readonly config;
  private readonly token: string;
  private listeners = new Set<Listener>();
  private state: ViewerState = { kind: 'loading' };
  private blocked = false;
  private closed = false;
  private delay = 10000;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: { controller: AbortController; promise: Promise<SharedAnalytics> };
  constructor(options: AnalyticsViewerOptions) {
    this.config = viewerOptions(options);
    this.token = options.token;
  }
  private visible = () => this.config.visibility?.visibilityState !== 'hidden';
  private notify(state: ViewerState) {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        /* A widget callback cannot break other subscribers. */
      }
    }
  }
  /** A single read; concurrent callers share the same in-flight request. */
  read(): Promise<SharedAnalytics> {
    if (this.closed || this.blocked)
      return Promise.reject(new AnalyticsViewerError(this.closed ? 'closed' : 'revoked'));
    if (this.request) return this.request.promise;
    const controller = new AbortController();
    const promise = this.fetchData(controller).finally(() => {
      if (this.request?.controller === controller) this.request = undefined;
    });
    this.request = { controller, promise };
    return promise;
  }
  private async fetchData(controller: AbortController): Promise<SharedAnalytics> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new AnalyticsViewerError('aborted')),
        { once: true },
      );
      timer = setTimeout(() => {
        reject(new AnalyticsViewerError('temporary'));
        controller.abort();
      }, 10000);
    });
    try {
      return await Promise.race([this.responseData(controller), interrupted]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async responseData(controller: AbortController) {
    const response = await this.config.fetcher(this.config.endpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.token}` },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (controller.signal.aborted) throw new AnalyticsViewerError('aborted');
    if ([401, 403, 404, 410].includes(response.status)) {
      this.blocked = true;
      this.notify({ kind: 'unavailable', reason: 'revoked' });
      throw new AnalyticsViewerError('revoked');
    }
    if (!response.ok) throw new AnalyticsViewerError('temporary');
    const data = parseSharedAnalytics(await response.json());
    if (controller.signal.aborted) throw new AnalyticsViewerError('aborted');
    if (!data) throw new AnalyticsViewerError('temporary');
    return data;
  }
  /** Visible subscriptions refresh every 10s; failures back off to at most 60s. */
  subscribe(listener: Listener): () => void {
    if (this.closed) {
      listener({ kind: 'closed' });
      return () => {};
    }
    this.listeners.add(listener);
    if (this.blocked) {
      this.notify({ kind: 'unavailable', reason: 'revoked' });
      return () => {
        this.listeners.delete(listener);
      };
    }
    if (this.listeners.size === 1) {
      this.config.visibility?.addEventListener('visibilitychange', this.visibilityChanged);
      this.visibilityChanged();
    } else {
      try {
        listener(this.state);
      } catch {
        /* Isolate host callbacks. */
      }
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopPolling();
    };
  }
  private visibilityChanged = () => {
    this.generation++;
    clearTimeout(this.timer);
    this.request?.controller.abort();
    this.request = undefined;
    if (this.closed || this.blocked) return;
    this.notify({ kind: this.visible() ? 'loading' : 'paused' });
    if (this.visible()) void this.poll();
  };
  private async poll() {
    if (this.closed || this.blocked || !this.visible() || !this.listeners.size) return;
    const promise = this.read();
    const generation = this.generation;
    try {
      const data = await promise;
      if (generation !== this.generation || this.closed) return;
      this.delay = 10000;
      this.notify({ kind: 'ready', data });
    } catch {
      if (generation !== this.generation || this.closed || this.blocked) return;
      this.delay = Math.min(60000, this.delay * 2);
      this.notify({ kind: 'unavailable', reason: 'temporary' });
    }
    if (!this.closed && !this.blocked && this.visible() && this.listeners.size)
      this.timer = setTimeout(() => void this.poll(), this.delay);
  }
  private stopPolling() {
    this.generation++;
    clearTimeout(this.timer);
    this.request?.controller.abort();
    this.request = undefined;
    this.config.visibility?.removeEventListener('visibilitychange', this.visibilityChanged);
    this.state = { kind: 'loading' };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopPolling();
    this.notify({ kind: 'closed' });
    this.listeners.clear();
  }
}
