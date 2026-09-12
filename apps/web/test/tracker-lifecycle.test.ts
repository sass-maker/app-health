import { BrowserBatchV1 } from '@app-health/contracts';
import type { AppHealthTracker } from '../public/tracker.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const tracker = () => window.appHealth as AppHealthTracker;
const payloads = () =>
  vi.mocked(fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
const validPayloads = () => payloads().map((payload) => BrowserBatchV1.parse(payload));

async function install(identity?: 'session') {
  vi.resetModules();
  const script = document.createElement('script');
  script.dataset.key = 'ahk_pub_lifecycle';
  script.dataset.endpoint = '/v1/browser';
  if (identity) script.dataset.identity = identity;
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
  await import('../public/tracker.js');
}

beforeEach(async () => {
  vi.useFakeTimers();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  await install();
});

afterEach(() => {
  tracker()?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('automatically retries a transient delivery with the same valid batch', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  await tracker().flush();
  await vi.advanceTimersByTimeAsync(4000);
  expect(fetch).toHaveBeenCalledTimes(2);
  const batches = validPayloads();
  expect(batches).toHaveLength(2);
  expect(batches[1].batch_id).toBe(batches[0].batch_id);
});

it('uses one stable unknown session when reads fail even if writes appear to succeed', async () => {
  tracker().stop();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  await install();
  vi.mocked(fetch).mockClear();
  await tracker().flush();
  tracker().track('second');
  await tracker().flush();
  const batches = validPayloads();
  expect(batches[0].session_id).toBe(batches[1].session_id);
  expect(batches.every((batch) => !batch.visitor_id)).toBe(true);
});

it('keeps session-only identity stable with blocked storage and includes attribution', async () => {
  tracker().stop();
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  history.replaceState({}, '', '/session?utm_source=newsletter&utm_medium=email');
  await install('session');
  vi.mocked(fetch).mockClear();
  await tracker().flush();
  tracker().track('opened');
  await tracker().flush();
  const batches = validPayloads();
  expect(batches[0].session_id).toBe(batches[1].session_id);
  expect(batches[0].attribution?.source).toBe('newsletter');
  expect(batches.every((batch) => !batch.visitor_id && !batch.visit_type)).toBe(true);
});

it('shares persistent context across reloads and starts a new visitor after 90 days', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  await install();
  vi.mocked(fetch).mockClear();
  await tracker().flush();
  const first = validPayloads()[0];
  tracker().stop();
  vi.setSystemTime(Date.now() + 90 * 24 * 60 * 60 * 1000 + 1);
  await install();
  vi.mocked(fetch).mockClear();
  await tracker().flush();
  const second = validPayloads()[0];
  expect(second.visitor_id).not.toBe(first.visitor_id);
  expect(second.visit_type).toBe('new');
});

it('splits meaningful events after 30 minutes while preserving queued context', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  await install();
  await tracker().flush();
  const first = validPayloads()[0];
  vi.mocked(fetch).mockClear();
  vi.setSystemTime(Date.now() + 1_800_001);
  tracker().track('after_idle');
  await tracker().flush();
  const second = validPayloads()[0];
  expect(second.session_id).not.toBe(first.session_id);
  expect(second.events[0].name).toBe('after_idle');
  expect(BrowserBatchV1.safeParse(second).success).toBe(true);
});

it('preserves the context of queued events when a later visit starts before delivery', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  await install();
  vi.setSystemTime(Date.now() + 1_800_001);
  tracker().track('next_visit');
  await tracker().flush();
  await tracker().flush();
  const [first, second] = validPayloads();
  expect(first.events.map((event) => event.type)).toEqual(['pageview']);
  expect(second.events.map((event) => event.name)).toEqual(['next_visit']);
  expect(first.visitor_id).toBe(second.visitor_id);
  expect(first.session_id).not.toBe(second.session_id);
  expect(first.visit_type).toBe('new');
  expect(second.visit_type).toBe('returning');
});

it('preserves visitor, visit and entry attribution on an internal reload', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  history.replaceState({}, '', '/entry?utm_source=launch');
  await install();
  await tracker().flush();
  const first = validPayloads()[0];
  tracker().stop();
  history.replaceState({}, '', '/pricing');
  await install();
  await tracker().flush();
  const second = validPayloads()[0];
  expect(second.session_id).toBe(first.session_id);
  expect(second.visitor_id).toBe(first.visitor_id);
  expect(second.attribution).toEqual(first.attribution);
});
