import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { BrowserBatchV1 } from '@app-health/contracts';
import type { AppHealthTracker } from '../public/tracker.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = (): AppHealthTracker => window.appHealth!;
const source = readFileSync('public/tracker.js', 'utf8');
let originalPush: History['pushState'];
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
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
it('ships under 3KB gzip and sends sanitized pageviews and explicit events without credentials', async () => {
  // Identity, attribution and storage-failure handling remain within a 3 KB compressed budget.
  expect(gzipSync(source).length).toBeLessThanOrEqual(3000);
  api().page('/users/123?email=private@example.com#token');
  api().track('signup.completed');
  await api().flush();
  const call = vi.mocked(fetch).mock.calls[0][1]!;
  expect(call.credentials).toBe('omit');
  const body = JSON.parse(String(call.body));
  expect(BrowserBatchV1.safeParse(body).success).toBe(true);
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
  for (const [, init] of vi.mocked(fetch).mock.calls)
    expect(BrowserBatchV1.safeParse(JSON.parse(String(init?.body))).success).toBe(true);
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
  // Losing storage can start a fallback session. Each session retains its own batch.
  await api().flush();
  const batches = vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  for (const batch of batches) {
    expect(BrowserBatchV1.safeParse(batch).success).toBe(true);
    expect(batch.session_id).toMatch(/^[a-f0-9-]{36}$/);
  }
  const events = batches.flatMap((batch) => batch.events);
  expect(events.slice(1).map((event: { path: string }) => event.path)).toEqual([
    '/',
    '/:path',
    '/:id',
  ]);
  expect(events[1].referrer).toBe('search.example');
});

it('supports strict session identity without persistent visitor fields', async () => {
  api().stop();
  vi.resetModules();
  const script = document.createElement('script');
  script.dataset.key = 'ahk_pub_test';
  script.dataset.identity = 'session';
  script.dataset.endpoint = '/v1/browser';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  await import('../public/tracker.js');
  vi.mocked(fetch).mockClear();
  await window.appHealth!.flush();
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(BrowserBatchV1.safeParse(body).success).toBe(true);
  expect(body).not.toHaveProperty('visitor_id');
  expect(body).not.toHaveProperty('visit_type');
});
it('keeps a persistent visit across a day and emits empty heartbeats without inventing events', async () => {
  await api().flush();
  const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  vi.setSystemTime(Date.now() + 86400000);
  await api().flush();
  const second = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
  expect(second.session_id).toBe(first.session_id);
  expect(second.visitor_id).toBe(first.visitor_id);
  expect(second.events).toEqual([]);
});

it('shares an anonymous visitor across reloads, rotates visits after inactivity, and persists attribution', async () => {
  api().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  history.replaceState({}, '', '/landing?utm_source=launch&utm_medium=email&utm_campaign=summer');
  vi.resetModules();
  const script = document.createElement('script');
  script.dataset.key = 'ahk_pub_test';
  script.dataset.endpoint = '/v1/browser';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  await import('../public/tracker.js');
  vi.mocked(fetch).mockClear();
  await api().flush();
  await api().flush();
  const first = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(first.visit_type).toBe('new');
  expect(first.attribution).toMatchObject({
    source: 'launch',
    medium: 'email',
    campaign: 'summer',
    entry_path: '/landing',
  });
  api().stop();
  vi.resetModules();
  const nextScript = document.createElement('script');
  nextScript.dataset.key = 'ahk_pub_test';
  nextScript.dataset.endpoint = '/v1/browser';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(nextScript);
  await import('../public/tracker.js');
  vi.setSystemTime(Date.now() + 1_800_001);
  api().page('/returning');
  await api().flush();
  await api().flush();
  const second = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
  expect(second.visitor_id).toBe(first.visitor_id);
  expect(second.session_id).not.toBe(first.session_id);
  expect(second.visit_type).toBe('returning');
  expect(second.attribution).toMatchObject({
    source: '',
    medium: '',
    campaign: '',
    entry_path: '/returning',
  });
});

it('sanitizes UTM values and omits persistent identity when storage is unavailable', async () => {
  api().stop();
  history.replaceState({}, '', '/landing?utm_source=alice%40example.com&utm_campaign=launch%21');
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('disabled');
  });
  vi.resetModules();
  const script = document.createElement('script');
  script.dataset.key = 'ahk_pub_test';
  script.dataset.endpoint = '/v1/browser';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  await import('../public/tracker.js');
  vi.mocked(fetch).mockClear();
  api().page('/landing?utm_source=alice%40example.com&utm_campaign=launch%21');
  await api().flush();
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body).not.toHaveProperty('visitor_id');
  expect(body.attribution).toMatchObject({ source: 'aliceexample.com', campaign: 'launch' });
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

it('does not count internal navigation as an external traffic source', async () => {
  vi.spyOn(document, 'referrer', 'get').mockReturnValue(`${location.origin}/pricing`);
  api().page('/docs');
  await api().flush();
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.events[1].referrer).toBe('');
});
