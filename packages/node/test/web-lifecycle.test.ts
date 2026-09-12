import { describe, expect, it, vi } from 'vitest';
import { createWebLogger } from '../src/web.js';

const KEY = 'ahk_pub_lifecycle_test';
const ok = { ok: true, status: 202 };

describe('createWebLogger lifecycle and bounded delivery', () => {
  it('counts beacon-retained batches against queue capacity and settles them on flush', async () => {
    const beacon = vi.fn(() => true);
    const fetch = vi.fn(async () => ok);
    const logger = createWebLogger({
      publicKey: KEY,
      maxQueueSize: 2,
      fetch,
      sendBeacon: beacon,
      lifecycle: false,
      disableTimer: true,
    });

    logger.log('beacon.first');
    expect(logger.flushBeacon()).toBe(true);
    logger.log('queued.second');
    logger.log('dropped.third');
    expect(logger.diagnostics()).toMatchObject({ queued: 2, dropped: 1, beaconQueued: 1 });

    await logger.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.diagnostics()).toMatchObject({ queued: 0, sent: 2, dropped: 1, beaconQueued: 0 });
  });

  it('drops a failed batch after three attempts and does not retry it on a later flush', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const logger = createWebLogger({ publicKey: KEY, fetch, lifecycle: false, disableTimer: true });
    logger.log('transient.failure');

    await logger.flush();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logger.diagnostics()).toMatchObject({ queued: 0, sent: 0, dropped: 1, retried: 2 });
    await logger.flush();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('aborts a hung fetch at the timeout and makes at most three attempts', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(
        async (_url: string, init: RequestInit) =>
          await new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const logger = createWebLogger({
        publicKey: KEY,
        fetch,
        lifecycle: false,
        disableTimer: true,
      });
      logger.log('hung.request');
      const pending = logger.flush();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6_300);
      await pending;
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(logger.diagnostics()).toMatchObject({ queued: 0, sent: 0, dropped: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes default DOM lifecycle listeners with their original receivers and closes cleanly', async () => {
    const windowListeners = new Map<string, () => void>();
    const documentListeners = new Map<string, () => void>();
    const windowAdd = vi.fn(function (this: unknown, type: string, listener: () => void) {
      windowListeners.set(type, listener);
      return this;
    });
    const windowRemove = vi.fn(function (this: unknown, type: string, _listener: () => void) {
      windowListeners.delete(type);
      return this;
    });
    const documentAdd = vi.fn(function (this: unknown, type: string, listener: () => void) {
      documentListeners.set(type, listener);
      return this;
    });
    const documentRemove = vi.fn(function (this: unknown, type: string, _listener: () => void) {
      documentListeners.delete(type);
      return this;
    });
    const windowObject = { addEventListener: windowAdd, removeEventListener: windowRemove };
    const documentObject = {
      visibilityState: 'visible',
      addEventListener: documentAdd,
      removeEventListener: documentRemove,
    };
    vi.stubGlobal('window', windowObject);
    vi.stubGlobal('document', documentObject);
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => ok);
      const logger = createWebLogger({ publicKey: KEY, fetch });
      expect(windowListeners.has('pagehide')).toBe(true);
      expect(documentListeners.has('visibilitychange')).toBe(true);
      logger.log('timer.cleanup');
      const close = logger.close();
      const sameClose = logger.close();
      expect(sameClose).toBe(close);
      await close;
      expect(windowRemove).toHaveBeenCalledWith('pagehide', expect.any(Function));
      expect(documentRemove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(windowRemove.mock.instances[0]).toBe(windowObject);
      expect(documentRemove.mock.instances[0]).toBe(documentObject);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('waits for queued work added during an in-flight flush and leaves no timer', async () => {
    let resolveFirst!: (value: { ok: boolean; status: number }) => void;
    let calls = 0;
    const fetch = vi.fn((_url: string, _init: RequestInit) =>
      calls++ === 0
        ? new Promise<{ ok: boolean; status: number }>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(ok),
    );
    const logger = createWebLogger({ publicKey: KEY, fetch, lifecycle: false, disableTimer: true });
    logger.log('first');
    const first = logger.flush();
    logger.log('queued.while.inflight');
    const close = logger.close();
    resolveFirst(ok);
    await Promise.all([first, close]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(logger.diagnostics()).toMatchObject({ queued: 0, sent: 2 });
  });

  it('uses UTF-8 byte limits to split large valid logs and drops one oversized batch', async () => {
    const bodies: string[] = [];
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return ok;
    });
    const logger = createWebLogger({
      publicKey: KEY,
      fetch,
      lifecycle: false,
      disableTimer: true,
      maxBatchSize: 100,
    });
    const large = 'é'.repeat(1_999);
    for (let index = 0; index < 40; index++) logger.log(`large.${index}`, { description: large });
    await logger.flush();
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.every((body) => new TextEncoder().encode(body).byteLength < 60 * 1024)).toBe(
      true,
    );
    expect(logger.diagnostics().sent).toBe(40);

    const oversized = createWebLogger({
      publicKey: KEY,
      fetch,
      lifecycle: false,
      disableTimer: true,
    });
    oversized.log('oversized.single', {
      props: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`field${i}`, '\0'.repeat(500)]),
      ),
    });
    await oversized.flush();
    expect(oversized.diagnostics()).toMatchObject({ queued: 0, sent: 0, dropped: 1 });
  });
});
