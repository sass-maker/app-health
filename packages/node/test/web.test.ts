import { describe, expect, it, vi } from 'vitest';
import {
  createWebLogger,
  type LogInput,
  type WebLifecycle,
  type WebLoggerDiagnostics,
} from '../src/web.js';
import { validateBrowserLogBatch } from '../../contracts/src/index.js';

const KEY = 'ahk_pub_test_key_0123456789';

function fakeFetch(ok = true) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok };
  });
  return { fetchImpl, calls };
}

function fakeLifecycle(state = 'visible') {
  const listeners = new Map<string, () => void>();
  const lifecycle: WebLifecycle = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    visibilityState: () => state,
  };
  return {
    lifecycle,
    fire: (type: string) => listeners.get(type)?.(),
    setState: (s: string) => (state = s),
  };
}

describe('createWebLogger', () => {
  it('rejects anything but a public key', () => {
    expect(() => createWebLogger({ publicKey: 'ahk_secret' })).toThrow(/publicKey/);
    expect(() => createWebLogger({ publicKey: undefined as unknown as string })).toThrow(
      /publicKey/,
    );
  });

  it('rejects unsafe endpoints and unbounded options during initialization', () => {
    expect(() =>
      createWebLogger({ publicKey: KEY, endpoint: 'https://user:pass@example.test' }),
    ).toThrow(/endpoint/);
    expect(() => createWebLogger({ publicKey: KEY, maxBatchSize: 0 })).toThrow(/maxBatchSize/);
    expect(() => createWebLogger({ publicKey: KEY, maxBatchSize: Number.NaN })).toThrow(
      /maxBatchSize/,
    );
  });

  it('posts a text/plain browser batch with the key in the body and keepalive', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const logger = createWebLogger({
      publicKey: KEY,
      environment: 'production',
      fetch: fetchImpl,
      lifecycle: false,
      disableTimer: true,
      randomUUID: () => '11111111-2222-4333-a444-555555555555',
      now: () => 1_725_000_000_000,
    });
    const input: LogInput = { props: { plan: 'pro' } };
    logger.log('pricing.viewed', input);
    logger.log('ui.error', { level: 'error', title: 'boom' });
    await logger.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ingest.sassmaker.com/v1/logs');
    expect(calls[0].init.keepalive).toBe(true);
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    const batch = JSON.parse(String(calls[0].init.body));
    expect(batch.public_key).toBe(KEY);
    expect(batch.environment).toBe('production');
    expect(batch.logs.map((l: { event: string }) => l.event)).toEqual([
      'pricing.viewed',
      'ui.error',
    ]);
    expect(validateBrowserLogBatch(batch).ok).toBe(true);
    const diagnostics: WebLoggerDiagnostics = logger.diagnostics();
    expect(diagnostics).toEqual({ queued: 0, sent: 2, dropped: 0, retried: 0, beaconQueued: 0 });
  });

  it('drops invalid logs and overflow, counts rejected and failed requests', async () => {
    const { fetchImpl } = fakeFetch(false);
    const logger = createWebLogger({
      publicKey: KEY,
      endpoint: 'https://ingest.test/v1/logs',
      fetch: fetchImpl,
      lifecycle: false,
      disableTimer: true,
      maxQueueSize: 2,
      maxBatchSize: 10,
    });
    logger.log('Bad Name');
    logger.log('one');
    logger.log('two');
    logger.log('three');
    expect(logger.diagnostics()).toEqual({
      queued: 2,
      sent: 0,
      dropped: 2,
      retried: 0,
      beaconQueued: 0,
    });
    await logger.flush();
    expect(logger.diagnostics()).toEqual({
      queued: 0,
      sent: 0,
      dropped: 4,
      retried: 0,
      beaconQueued: 0,
    });
    const throwing = createWebLogger({
      publicKey: KEY,
      fetch: async () => {
        throw new Error('offline');
      },
      lifecycle: false,
      disableTimer: true,
    });
    throwing.log('x');
    await throwing.flush();
    expect(throwing.diagnostics().dropped).toBe(1);
  });

  it('flushes automatically at the batch size and after the timer', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = fakeFetch();
      const logger = createWebLogger({
        publicKey: KEY,
        fetch: fetchImpl,
        lifecycle: false,
        maxBatchSize: 2,
        flushIntervalMs: 500,
      });
      logger.log('a');
      expect(calls).toHaveLength(0);
      logger.log('b');
      await vi.runAllTicks();
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      logger.log('c');
      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent flushes and retries transient responses with one batch id', async () => {
    const calls: RequestInit[] = [];
    let attempts = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      attempts += 1;
      return attempts === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    });
    const logger = createWebLogger({
      publicKey: KEY,
      fetch: fetchImpl,
      lifecycle: false,
      disableTimer: true,
      randomUUID: () => '11111111-2222-4333-a444-555555555555',
    });
    logger.log('retryable');
    await Promise.all([logger.flush(), logger.flush()]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0].credentials).toBe('omit');
    expect(JSON.parse(String(calls[0].body)).batch_id).toBe(
      JSON.parse(String(calls[1].body)).batch_id,
    );
    expect(logger.diagnostics()).toMatchObject({ sent: 1, retried: 1 });
  });

  it('uses sendBeacon on pagehide and when the page becomes hidden', () => {
    const beacon = vi.fn((_url: string, _body: string) => true);
    const { lifecycle, fire, setState } = fakeLifecycle();
    const logger = createWebLogger({
      publicKey: KEY,
      sendBeacon: beacon,
      lifecycle,
      disableTimer: true,
    });
    expect(logger.flushBeacon()).toBe(true);
    expect(beacon).not.toHaveBeenCalled();
    logger.log('leaving');
    fire('visibilitychange');
    expect(beacon).not.toHaveBeenCalled();
    setState('hidden');
    fire('visibilitychange');
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(beacon.mock.calls[0][1])).logs[0].event).toBe('leaving');
    logger.log('gone');
    fire('pagehide');
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(logger.diagnostics()).toMatchObject({ sent: 0, beaconQueued: 2 });
    const rejected = createWebLogger({ publicKey: KEY, sendBeacon: () => false, lifecycle: false });
    rejected.log('x');
    expect(rejected.flushBeacon()).toBe(false);
    expect(rejected.diagnostics().dropped).toBe(1);
  });

  it('falls back safely outside a browser: no lifecycle, beacon unavailable, global fetch used', async () => {
    const logger = createWebLogger({ publicKey: KEY, disableTimer: true });
    logger.log('x');
    // Node has `navigator` but no sendBeacon, so the default beacon reports failure.
    expect(logger.flushBeacon()).toBe(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    logger.log('y');
    await logger.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it('wires real window/document listeners when they exist', () => {
    const listeners = new Map<string, () => void>();
    const beacon = vi.fn((_url: string, _body: string) => true);
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    });
    const doc = {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    };
    vi.stubGlobal('document', doc);
    try {
      const logger = createWebLogger({ publicKey: KEY, sendBeacon: beacon, disableTimer: true });
      logger.log('x');
      listeners.get('visibilitychange')?.();
      expect(beacon).not.toHaveBeenCalled();
      doc.visibilityState = 'hidden';
      listeners.get('visibilitychange')?.();
      expect(beacon).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
