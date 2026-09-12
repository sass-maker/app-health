import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { AppHealthTracker } from '../public/tracker.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = (): AppHealthTracker => window.appHealth!;
const source = readFileSync('public/tracker.js', 'utf8');
let originalPush: History['pushState'];
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  originalPush = history.pushState;
  const script = document.createElement('script');
  script.dataset.key = 'ahk_pub_test';
  script.dataset.endpoint = '/v1/browser';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
  await import('../public/tracker.js');
});
afterEach(() => {
  api()?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('ships under 2KB gzip and sends sanitized pageviews and explicit events without credentials', async () => {
  expect(gzipSync(source).length).toBeLessThanOrEqual(2048);
  api().page('/users/123?email=private@example.com#token');
  api().track('signup.completed');
  await api().flush();
  const call = vi.mocked(fetch).mock.calls[0][1]!;
  expect(call.credentials).toBe('omit');
  const body = JSON.parse(String(call.body));
  expect(body.events).toHaveLength(3);
  expect(body.events[1].path).toBe('/users/:id');
  expect(body.events[2].name).toBe('signup.completed');
  expect(String(call.body)).not.toContain('private@example.com');
  expect(api().diagnostics().accepted).toBe(3);
});
it('retries the same batch ID, bounds retry attempts and reports dropped events', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  await api().flush();
  await api().flush();
  await api().flush();
  const ids = vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => JSON.parse(String(init?.body)).batch_id);
  expect(new Set(ids).size).toBe(1);
  expect(api().diagnostics()).toMatchObject({ retries: 3, dropped: 1, queued: 0 });
});
it('tracks SPA navigation once and restores hooks and timers on stop', async () => {
  history.pushState({}, '', '/pricing');
  history.replaceState({}, '', '/pricing?utm_source=test');
  api().track('invalid event name');
  await api().flush();
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).events).toHaveLength(2);
  expect(api().diagnostics().dropped).toBe(1);
  api().stop();
  expect(history.pushState).toBe(originalPush);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('keeps a beacon batch for retry until an acknowledged response and sends no hidden heartbeats', async () => {
  const beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal('navigator', { sendBeacon: beacon });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  window.dispatchEvent(new Event('pagehide'));
  expect(beacon).toHaveBeenCalledOnce();
  expect(api().diagnostics().accepted).toBe(0);
  await vi.advanceTimersByTimeAsync(16000);
  expect(fetch).not.toHaveBeenCalled();
});

it('bounds queued events and never retries permanent collector rejection', async () => {
  for (let index = 0; index < 105; index++) api().track('checkout');
  expect(api().diagnostics()).toMatchObject({ queued: 100, dropped: 6 });
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);
  await api().flush();
  expect(api().diagnostics()).toMatchObject({ queued: 75, dropped: 31, retries: 0 });
});
it('survives disabled storage and malformed or oversized paths, and stores only referrer host', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://search.example/path?q=private');
  api().page('/%ZZ');
  api().page('/' + 'abcd/'.repeat(100));
  api().page('/alice%40example.com');
  await api().flush();
  const events = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).events;
  expect(events.slice(1).map((event: { path: string }) => event.path)).toEqual([
    '/',
    '/:path',
    '/:id',
  ]);
  expect(events[1].referrer).toBe('search.example');
});
it('rotates a daily session and emits empty heartbeats without inventing events', async () => {
  await api().flush();
  const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  vi.setSystemTime(Date.now() + 86400000);
  await api().flush();
  const second = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
  expect(second.session_id).not.toBe(first.session_id);
  expect(second.events).toEqual([]);
});
it('uses at most two idle heartbeats per visible minute and cancels redundant scheduled flushes', async () => {
  await api().flush();
  vi.mocked(fetch).mockClear();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_001);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [, init] of vi.mocked(fetch).mock.calls)
    expect(JSON.parse(String(init?.body)).events).toEqual([]);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('does not install duplicate trackers or initialize without a public key', async () => {
  const first = api();
  vi.resetModules();
  await import('../public/tracker.js');
  expect(api()).toBe(first);
  first.stop();
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(null);
  vi.resetModules();
  await import('../public/tracker.js');
  expect(api()).toBeUndefined();
});
it('aborts outstanding delivery on stop and drops unsupported referrer host syntax', async () => {
  vi.spyOn(document, 'referrer', 'get').mockReturnValue('http://[::1]/private');
  api().page('/pricing');
  let signal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const tracker = api();
  const delivery = tracker.flush();
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.events[1].referrer).toBe('');
  tracker.stop();
  expect(signal?.aborted).toBe(true);
  await delivery;
  await vi.advanceTimersByTimeAsync(60000);
  expect(fetch).toHaveBeenCalledOnce();
});
