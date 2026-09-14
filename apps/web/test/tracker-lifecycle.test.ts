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

it.each([
  'https://www.reddit.com/r/macapps/comments/private?secret=value',
  'https://t.co/private',
  'https://x.com/user/status/private',
])('preserves automatic referral attribution without UTMs from %s', async (referrer) => {
  tracker().stop();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  history.replaceState({}, '', '/landing');
  vi.spyOn(document, 'referrer', 'get').mockReturnValue(referrer);
  await install();
  await tracker().flush();
  vi.spyOn(document, 'referrer', 'get').mockReturnValue(`${location.origin}/landing`);
  history.pushState({}, '', '/download');
  await tracker().flush();
  const batches = validPayloads();
  expect(batches[0].attribution?.source).toBe(new URL(referrer).hostname);
  expect(batches[1].attribution?.source).toBe(batches[0].attribution?.source);
  expect(batches[1].session_id).toBe(batches[0].session_id);
  expect(JSON.stringify(batches)).not.toContain('secret=value');
  expect(JSON.stringify(batches)).not.toContain('/user/status/private');
});

it('does not reuse the original document referrer after a visit expires', async () => {
  tracker().stop();
  history.replaceState({}, '', '/landing');
  vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://www.reddit.com/r/example');
  await install();
  await tracker().flush();
  const first = validPayloads()[0];
  vi.setSystemTime(Date.now() + 1_800_001);
  tracker().track('resumed');
  await tracker().flush();
  const second = validPayloads().at(-1)!;
  expect(second.session_id).not.toBe(first.session_id);
  expect(second.attribution?.source).toBe('');
  expect(second.events[0].referrer).toBe('');
});

it('stops idle presence after the visit expires without inventing another session', async () => {
  await tracker().flush();
  vi.mocked(fetch).mockClear();
  vi.setSystemTime(Date.now() + 1_800_001);
  await tracker().flush();
  expect(fetch).not.toHaveBeenCalled();
});

it('adopts another tab’s current session for heartbeats without reviving its old session', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  await install();
  await tracker().flush();
  const original = validPayloads()[0];
  const key = 'h:ahk_pub_lifecycle:w';
  const next = { ...JSON.parse(values.get(key)!), id: crypto.randomUUID(), last: Date.now() };
  values.set(key, JSON.stringify(next));
  await tracker().flush();
  const heartbeat = validPayloads().at(-1)!;
  expect(heartbeat.session_id).not.toBe(original.session_id);
  expect(heartbeat.session_id).toBe(next.id);
  expect(heartbeat.events).toEqual([]);
});

it('does not replay an expired empty heartbeat after a delivery failure', async () => {
  await tracker().flush();
  vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  await tracker().flush();
  vi.mocked(fetch).mockClear();
  vi.setSystemTime(Date.now() + 1_800_001);
  await tracker().flush();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['reload', 'back_forward'])('does not reuse an expired source on %s', async (type) => {
  tracker().stop();
  vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://reddit.com/old');
  vi.stubGlobal('performance', { getEntriesByType: () => [{ type }] });
  await install();
  await tracker().flush();
  expect(validPayloads()[0].attribution?.source).toBe('');
});

it('waits for cross-tab coordination before flushing and bounds waiting records', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.fn((_key: string, record: () => void) => gate.then(record));
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  try {
    await install();
    for (let i = 0; i < 150; i++) tracker().track('queued');
    expect(tracker().diagnostics()).toMatchObject({ queued: 100, dropped: 51 });
    const flush = tracker().flush();
    expect(fetch).not.toHaveBeenCalled();
    release();
    await flush;
    expect(validPayloads()[0].events).toHaveLength(25);
    expect(request).toHaveBeenCalledTimes(100);
  } finally {
    Reflect.deleteProperty(navigator, 'locks');
  }
});

it('falls back to a stable unidentified session if browser locks are denied', async () => {
  tracker().stop();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: vi.fn().mockRejectedValue(new Error('SecurityError')) },
  });
  try {
    await install();
    await tracker().flush();
    tracker().track('next');
    await tracker().flush();
    const [first, second] = validPayloads();
    expect(first.session_id).toBe(second.session_id);
    expect(first.visitor_id).toBeUndefined();
    expect(second.visitor_id).toBeUndefined();
    expect(tracker().diagnostics().accepted).toBe(2);
  } finally {
    Reflect.deleteProperty(navigator, 'locks');
  }
});

it('records restored back-forward cache visits without duplicating the initial pageshow', async () => {
  await tracker().flush();
  const first = validPayloads()[0];
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
  expect(tracker().diagnostics().queued).toBe(0);
  vi.setSystemTime(Date.now() + 1_800_001);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  await tracker().flush();
  const restored = validPayloads().at(-1)!;
  expect(restored.session_id).not.toBe(first.session_id);
  expect(restored.events.map((event) => event.type)).toEqual(['pageview']);
  expect(restored.attribution?.source).toBe('');
});
