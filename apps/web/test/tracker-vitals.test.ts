import { Blob } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { validateBrowserLogBatch, WebVitalsProps } from '@app-health/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import vitalsSource from '../public/vitals.js?raw';

type Entry = {
  startTime?: number;
  value?: number;
  hadRecentInput?: boolean;
  interactionId?: number;
  duration?: number;
};
const runVitals = () => new Function(vitalsSource)();
const vitalsWindow = window as Window & { appHealthVitals?: { stop(): void } };
const observers = new Map<string, Observer>();
let unsupported: string[];
class Observer {
  static supportedEntryTypes: string[] | undefined;
  type = '';
  pending: Entry[] = [];
  disconnect = vi.fn();
  takeRecords = vi.fn(() => this.pending.splice(0));
  constructor(private callback: (list: { getEntries: () => Entry[] }) => void) {}
  observe = vi.fn((options: PerformanceObserverInit) => {
    if (unsupported.includes(options.type!)) throw new Error('unsupported');
    this.type = options.type!;
    observers.set(this.type, this);
  });
  emit(entries: Entry[]) {
    this.callback({ getEntries: () => entries });
  }
}

const beacon = vi.fn().mockReturnValue(true);
const logsEndpoint = 'https://ingest.sassmaker.com/v1/logs';
const logCalls = () => beacon.mock.calls.filter(([target]) => String(target).endsWith('/v1/logs'));
const emit = (type: string, entries: Entry[]) => observers.get(type)?.emit(entries);
function hidden() {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
}
async function batch() {
  const blob = logCalls()[0][1] as Blob;
  const body = await blob.text();
  const parsed = JSON.parse(body);
  const validation = validateBrowserLogBatch(parsed);
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error(validation.errors.join(', '));
  expect(WebVitalsProps.safeParse(validation.batch.logs[0].props).success).toBe(true);
  return validation.batch;
}
async function install(
  data: Record<string, string> = {},
  navigation: { type?: string; responseStart?: number } | null = { responseStart: 125.6 },
  interactionCount?: number,
) {
  vi.resetModules();
  const script = document.createElement('script');
  Object.assign(script.dataset, { key: 'ahk_pub_vitals', ...data });
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  vi.stubGlobal('performance', {
    getEntriesByType: () => (navigation ? [navigation] : []),
    interactionCount,
    now: () => 100000,
  });
  runVitals();
}
async function installTracker(
  data: Record<string, string> = {},
  src = 'https://health.example/tracker.js',
) {
  vi.resetModules();
  const script = document.createElement('script');
  Object.assign(script.dataset, { key: 'ahk_pub_vitals', ...data });
  if (src) script.src = src;
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  await import('../public/tracker.js');
}
const loadedScripts = () => document.head.querySelectorAll<HTMLScriptElement>('script');
beforeEach(() => {
  vi.useFakeTimers();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
  history.replaceState({}, '', '/');
  observers.clear();
  unsupported = [];
  Observer.supportedEntryTypes = undefined;
  beacon.mockReset().mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.stubGlobal('navigator', { sendBeacon: beacon, webdriver: false });
  vi.stubGlobal('PerformanceObserver', Observer);
  vi.stubGlobal('Blob', Blob);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
});
afterEach(() => {
  window.appHealth?.stop();
  vitalsWindow.appHealthVitals?.stop();
  delete vitalsWindow.appHealthVitals;
  loadedScripts().forEach((script) => script.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('ships vitals separately within its gzip budget', () => {
  // Standalone vitals.js is about 2.9 KB gzip; 3000 permits roughly 4% growth.
  expect(gzipSync(vitalsSource).length).toBeLessThanOrEqual(3000);
});

it.each(['', '1', 'true'])(
  'loads deferred vitals from the tracker host with copied attributes for %j',
  async (vitals) => {
    const data = {
      vitals,
      endpoint: '/collector/v1/browser',
      vitalsEndpoint: 'https://custom.example/logs',
      vitalsSample: '0.1',
    };
    await installTracker(data, 'https://health.example/assets/tracker.js');
    expect(loadedScripts()).toHaveLength(1);
    const script = loadedScripts()[0];
    expect(script.src).toBe('https://health.example/assets/vitals.js');
    expect(script.defer).toBe(true);
    expect({ ...script.dataset }).toEqual({
      key: 'ahk_pub_vitals',
      vitals,
      vitalsPath: '/',
      endpoint: data.endpoint,
      vitalsEndpoint: data.vitalsEndpoint,
      vitalsSample: data.vitalsSample,
    });
    expect(observers.size).toBe(0);
    hidden();
    expect(logCalls()).toHaveLength(0);
  },
);

it('leaves missing optional attributes unset in the loader', async () => {
  await installTracker({ vitals: '' });
  expect({ ...loadedScripts()[0].dataset }).toEqual({
    key: 'ahk_pub_vitals',
    vitals: '',
    vitalsPath: '/',
  });
});

it.each([undefined, 'false', '0', 'TRUE', 'yes'])(
  'does not load vitals when data-vitals is %j',
  async (vitals) => {
    await installTracker(vitals === undefined ? {} : { vitals });
    expect(loadedScripts()).toHaveLength(0);
    expect(observers.size).toBe(0);
    hidden();
    expect(logCalls()).toHaveLength(0);
  },
);

it.each(['', 'https://health.example/other.js', 'https://health.example/tracker.js?v=1'])(
  'does not load vitals from a non-tracker source %j',
  async (src) => {
    await installTracker({ vitals: '' }, src);
    expect(loadedScripts()).toHaveLength(0);
  },
);

it.each(['', 'ahk_private_test'])(
  'does not initialize standalone vitals with invalid key %j',
  async (key) => {
    await install({ key });
    expect(vitalsWindow.appHealthVitals).toBeUndefined();
    expect(observers.size).toBe(0);
    hidden();
    expect(logCalls()).toHaveLength(0);
  },
);

it('does not initialize standalone vitals without a current script', async () => {
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(null);
  runVitals();
  expect(vitalsWindow.appHealthVitals).toBeUndefined();
  expect(observers.size).toBe(0);
});

it('sends one valid debug log at send time without requiring data-vitals', async () => {
  await install();
  expect(Object.keys(vitalsWindow.appHealthVitals!)).toEqual(['stop']);
  expect(window.appHealth).toBeUndefined();
  vi.setSystemTime(Date.now() + 10000);
  hidden();
  const report = await batch();
  expect(report).toMatchObject({ schema_version: 'v1', public_key: 'ahk_pub_vitals' });
  expect(report.logs).toHaveLength(1);
  expect(report.logs[0]).toMatchObject({
    event: 'web.vitals',
    level: 'debug',
    timestamp: Date.now(),
    props: { route_group: '/', nav_type: 'navigate', ttfb_ms: 126, cls_milli: 0 },
  });
  expect(Object.keys(report.logs[0].props).sort()).toEqual([
    'cls_milli',
    'nav_type',
    'route_group',
    'ttfb_ms',
  ]);
  expect(logCalls()[0][0]).toBe(logsEndpoint);
  expect((logCalls()[0][1] as Blob).type).toBe('text/plain');
  for (const observer of observers.values())
    expect(observer.observe).toHaveBeenCalledWith({
      type: observer.type,
      buffered: true,
      ...(observer.type === 'event' ? { durationThreshold: 40 } : {}),
    });
});

it('tracker stop calls the loaded vitals stop hook', async () => {
  await installTracker({ vitals: '' });
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(loadedScripts()[0]);
  vi.stubGlobal('performance', { getEntriesByType: () => [{ responseStart: 125.6 }] });
  runVitals();
  const stop = vi.spyOn(vitalsWindow.appHealthVitals!, 'stop');
  window.appHealth!.stop();
  expect(stop).toHaveBeenCalledOnce();
  for (const observer of observers.values()) expect(observer.disconnect).toHaveBeenCalledOnce();
  hidden();
  expect(logCalls()).toHaveLength(0);
});

it('vitals delivery leaves tracker diagnostics unchanged', async () => {
  await installTracker({ vitals: '' });
  const before = window.appHealth!.diagnostics();
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(loadedScripts()[0]);
  vi.stubGlobal('performance', { getEntriesByType: () => [{ responseStart: 125.6 }] });
  runVitals();
  hidden();
  expect(logCalls()).toHaveLength(1);
  expect(window.appHealth!.diagnostics()).toEqual(before);
});

it('samples once per document and skips an unselected document', async () => {
  await install({ vitalsSample: '0.0001' });
  hidden();
  window.dispatchEvent(new Event('pagehide'));
  expect(logCalls()).toHaveLength(0);
  expect(observers.size).toBe(0);
  expect(Math.random).toHaveBeenCalledOnce();
});

it.each(['0', '-1', '2', 'invalid', '', 'Infinity'])(
  'defaults invalid sample %j to one',
  async (vitalsSample) => {
    await install({ vitalsSample });
    hidden();
    expect(logCalls()).toHaveLength(1);
  },
);

it('does not emit for webdriver', async () => {
  vi.stubGlobal('navigator', { sendBeacon: beacon, webdriver: true });
  await install();
  hidden();
  expect(logCalls()).toHaveLength(0);
  expect(observers.size).toBe(0);
});

it.each([
  ['/', '/'],
  ['/articles/123', '/articles'],
  ['/123', '/other'],
  ['/01234567-89ab-4cde-8fab-0123456789ab', '/other'],
  ['/abcdef1234567890', '/other'],
  ['/articles?q=secret#private', '/articles'],
  ['/ARTICLES/123', '/articles'],
  ['/' + 'a'.repeat(41), '/other'],
  ['/private%40example.com', '/other'],
  ['//articles', '/other'],
])('groups initial path %s as %s without subsequent SPA paths', async (path, route_group) => {
  // An absolute same-origin URL preserves a pathname beginning with two slashes.
  history.replaceState({}, '', location.origin + path);
  await install();
  history.pushState({}, '', '/different');
  hidden();
  expect((await batch()).logs[0].props.route_group).toBe(route_group);
});

it.each(['navigate', 'reload', 'back_forward', 'prerender', 'unknown'])(
  'maps navigation type %s',
  async (type) => {
    await install({}, { type, responseStart: 1 });
    hidden();
    expect((await batch()).logs[0].props.nav_type).toBe(type === 'unknown' ? 'navigate' : type);
  },
);

it.each(['keydown', 'click', 'pointerdown'])(
  'finalizes buffered LCP on first %s',
  async (input) => {
    await install({}, null);
    emit('largest-contentful-paint', [{ startTime: 100 }, { startTime: 1200.6 }]);
    observers.get('largest-contentful-paint')!.pending = [{ startTime: 1400.4 }];
    document.dispatchEvent(new Event(input));
    emit('largest-contentful-paint', [{ startTime: 2000 }]);
    hidden();
    expect((await batch()).logs[0].props).toMatchObject({ lcp_ms: 1400 });
    expect(observers.get('largest-contentful-paint')!.disconnect).toHaveBeenCalled();
  },
);

it('drains buffered records and finalizes LCP when hidden', async () => {
  await install({}, null);
  observers.get('largest-contentful-paint')!.pending = [{ startTime: 1234.7 }];
  hidden();
  expect((await batch()).logs[0].props.lcp_ms).toBe(1235);
});

it('uses the maximum CLS session window with input exclusion, a 1s gap and a 5s span', async () => {
  await install({}, null);
  emit('layout-shift', [
    { startTime: 0, value: 0.1 },
    { startTime: 500, value: 0.2 },
    { startTime: 600, value: 9, hadRecentInput: true },
    { startTime: 1600, value: 0.25 },
    ...[2400, 3200, 4000, 4800, 5600, 6400].map((startTime) => ({ startTime, value: 0.05 })),
    { startTime: 6800, value: 0.5 },
  ]);
  hidden();
  expect((await batch()).logs[0].props.cls_milli).toBe(550);
});

it('starts the CLS window at the first eligible shift rather than document start', async () => {
  await install({}, null);
  emit('layout-shift', [
    ...[900, 1800, 2700, 3600, 4500, 5400].map((startTime) => ({ startTime, value: 0.1 })),
    { startTime: 6000, value: 0.5 },
  ]);
  hidden();
  expect((await batch()).logs[0].props.cls_milli).toBe(600);
});

it('sends a measured zero CLS beside other metrics, omits INP without interaction IDs, and never sends a lone zero CLS', async () => {
  await install({}, { type: 'navigate', responseStart: 50 });
  emit('layout-shift', [{ startTime: 100, value: 0 }]);
  emit('event', [{ interactionId: 0, duration: 100 }]);
  hidden();
  expect((await batch()).logs[0].props).toEqual({
    route_group: '/',
    nav_type: 'navigate',
    ttfb_ms: 50,
    cls_milli: 0,
  });
  vi.clearAllMocks();
  await install({}, null);
  emit('layout-shift', [{ startTime: 100, value: 0 }]);
  hidden();
  expect(logCalls()).toHaveLength(0);
});

it.each([1, 49, 50, 100])(
  'selects INP from per-interaction maxima for %i interactions',
  async (count) => {
    await install({}, null);
    emit('event', [
      { interactionId: 0, duration: 10000 },
      ...Array.from({ length: count }, (_, i) => ({ interactionId: i + 1, duration: 1000 - i })),
      { interactionId: 1, duration: 40 },
    ]);
    hidden();
    expect((await batch()).logs[0].props.inp_ms).toBe(1000 - Math.floor(count / 50));
  },
);

it('rounds and clamps all metric values', async () => {
  await install({}, { responseStart: 900000 });
  emit('largest-contentful-paint', [{ startTime: -10 }]);
  emit('event', [{ interactionId: 1, duration: 900000 }]);
  emit('layout-shift', [{ startTime: 1, value: 20 }]);
  hidden();
  expect((await batch()).logs[0].props).toMatchObject({
    ttfb_ms: 600000,
    lcp_ms: 0,
    inp_ms: 600000,
    cls_milli: 10000,
  });
});

it('clamps a negative navigation timing to zero', async () => {
  await install({}, { responseStart: -1 });
  hidden();
  expect((await batch()).logs[0].props.ttfb_ms).toBe(0);
});

it.each(['hidden', 'pagehide'])(
  'sends once when %s comes first, including across a bfcache restore',
  async (first) => {
    await install();
    if (first === 'hidden') hidden();
    else window.dispatchEvent(new Event('pagehide'));
    hidden();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    hidden();
    expect(logCalls()).toHaveLength(1);
  },
);

it('stop disconnects observers and removes vitals lifecycle and input listeners', async () => {
  await install();
  const documentRemoval = vi.spyOn(document, 'removeEventListener');
  const windowRemoval = vi.spyOn(window, 'removeEventListener');
  vitalsWindow.appHealthVitals!.stop();
  for (const observer of observers.values()) expect(observer.disconnect).toHaveBeenCalledOnce();
  for (const type of ['keydown', 'click', 'pointerdown'])
    expect(documentRemoval).toHaveBeenCalledWith(type, expect.any(Function), true);
  expect(documentRemoval.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(
    1,
  );
  expect(windowRemoval.mock.calls.filter(([type]) => type === 'pagehide')).toHaveLength(1);
  hidden();
  window.dispatchEvent(new Event('pagehide'));
  emit('largest-contentful-paint', [{ startTime: 100 }]);
  expect(logCalls()).toHaveLength(0);
});

it.each(['visible', 'hidden', 'prerender'])(
  'sends nothing with no metrics when initially %s',
  async (state) => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(
      state === 'visible' ? 'visible' : 'hidden',
    );
    await install({}, { responseStart: 0, type: state === 'prerender' ? 'prerender' : 'navigate' });
    hidden();
    expect(logCalls()).toHaveLength(0);
  },
);

it('omits unsupported metrics while retaining navigation timing', async () => {
  unsupported = ['largest-contentful-paint', 'layout-shift', 'event'];
  await install();
  hidden();
  expect((await batch()).logs[0].props).toEqual({
    route_group: '/',
    nav_type: 'navigate',
    ttfb_ms: 126,
  });
});

it('does not observe entry types the browser declares unsupported', async () => {
  Observer.supportedEntryTypes = [];
  await install();
  hidden();
  expect(observers.size).toBe(0);
  expect((await batch()).logs[0].props.ttfb_ms).toBe(126);
});

it('derives a custom collector endpoint', async () => {
  await install({ endpoint: '/collector/v1/browser' });
  hidden();
  expect(logCalls()[0][0]).toBe('/collector/v1/logs');
});

it.each(['false', 'absent', 'throws'])(
  'uses one text/plain keepalive fetch when beacon is %s',
  async (mode) => {
    if (mode === 'absent') vi.stubGlobal('navigator', { webdriver: false });
    else if (mode === 'throws')
      beacon.mockImplementation(() => {
        throw new Error('denied');
      });
    else beacon.mockReturnValue(false);
    await install({ vitalsEndpoint: 'https://custom.example/logs' });
    hidden();
    window.dispatchEvent(new Event('pagehide'));
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([target]) => target === 'https://custom.example/logs');
    expect(calls).toHaveLength(1);
    const init = calls[0][1]!;
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      credentials: 'omit',
      keepalive: true,
    });
    const body = JSON.parse(String(init.body));
    expect(validateBrowserLogBatch(body).ok).toBe(true);
    expect(WebVitalsProps.safeParse(body.logs[0].props).success).toBe(true);
  },
);

it.each(['synchronous', 'rejected'])(
  'silently absorbs a %s fetch failure with no retries',
  async (mode) => {
    beacon.mockReturnValue(false);
    await install();
    if (mode === 'synchronous')
      vi.mocked(fetch).mockImplementation(() => {
        throw new Error('denied');
      });
    else vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    expect(hidden).not.toThrow();
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it('uses the browser interaction count so one slow event among 50 interactions is excluded from INP', async () => {
  await install({}, { responseStart: 10 }, 50);
  emit('event', [
    { interactionId: 1, duration: 500 },
    { interactionId: 2, duration: 300 },
  ]);
  hidden();
  expect((await batch()).logs[0].props.inp_ms).toBe(300);
});

it('maps only owner-allowlisted first segments when data-vitals-routes is set', async () => {
  history.replaceState({}, '', '/alice-private-project/x');
  await install({ vitalsRoutes: 'Docs, pricing' });
  hidden();
  expect((await batch()).logs[0].props.route_group).toBe('/other');
  vi.clearAllMocks();
  history.replaceState({}, '', '/docs/intro');
  await install({ vitalsRoutes: 'docs,pricing' });
  hidden();
  expect((await batch()).logs[0].props.route_group).toBe('/docs');
});

it('does not start when the tracker was stopped while vitals.js was loading', async () => {
  await installTracker({ vitals: '' });
  window.appHealth?.stop();
  vi.resetModules();
  const script = document.createElement('script');
  Object.assign(script.dataset, { key: 'ahk_pub_vitals' });
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  runVitals();
  expect(observers.size).toBe(0);
  hidden();
  expect(logCalls()).toHaveLength(0);
});

it('reports a measured zero INP when interactions occurred but none exceeded the event threshold', async () => {
  await install({}, { responseStart: 10 }, 3);
  hidden();
  expect((await batch()).logs[0].props.inp_ms).toBe(0);
});

it('treats ranks beyond the captured slow interactions as below the threshold', async () => {
  await install({}, { responseStart: 10 }, 50);
  emit('event', [{ interactionId: 1, duration: 500 }]);
  hidden();
  expect((await batch()).logs[0].props.inp_ms).toBe(0);
});

it('normalizes prerendered documents against activation', async () => {
  await install({}, { type: 'navigate', responseStart: 1200, activationStart: 1000 } as never);
  emit('largest-contentful-paint', [{ startTime: 1500 }]);
  hidden();
  expect((await batch()).logs[0].props).toMatchObject({
    nav_type: 'prerender',
    ttfb_ms: 200,
    lcp_ms: 500,
  });
});

it('ignores LCP entries painted after the document was first hidden', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await install({}, { responseStart: 10 });
  emit('largest-contentful-paint', [{ startTime: 9000 }]);
  hidden();
  expect((await batch()).logs[0].props.lcp_ms).toBeUndefined();
});

it('uses the path captured by the tracker instead of a later route', async () => {
  history.replaceState({}, '', '/later-route');
  await install({ vitalsPath: '/docs/start' });
  hidden();
  expect((await batch()).logs[0].props.route_group).toBe('/docs');
});

it('waits for prerender activation before initializing', async () => {
  Object.defineProperty(document, 'prerendering', { configurable: true, value: true });
  try {
    await install({}, { responseStart: 10 });
    expect(observers.size).toBe(0);
    Object.defineProperty(document, 'prerendering', { configurable: true, value: false });
    document.dispatchEvent(new Event('prerenderingchange'));
    expect(observers.size).toBeGreaterThan(0);
    hidden();
    expect((await batch()).logs[0].props.ttfb_ms).toBe(10);
  } finally {
    delete (document as unknown as { prerendering?: boolean }).prerendering;
  }
});
