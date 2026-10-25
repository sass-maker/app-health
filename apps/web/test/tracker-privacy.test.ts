import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserBatchV1 } from '@app-health/contracts';
import type { AppHealthTracker } from '../public/tracker.js';
import { start, assetURL } from '../public/tracker-extras.js';

const api = (): AppHealthTracker => window.appHealth!;
const batches = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => BrowserBatchV1.parse(JSON.parse(String(init?.body))));
let values: Map<string, string>;
let store: {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};
const key = 'ahk_pub_privacy';
const preference = `h:${key}:ignore`;
async function install(data: Record<string, string | undefined> = {}, src = '') {
  vi.resetModules();
  const script = document.createElement('script');
  Object.assign(script.dataset, { key, ...data });
  if (src) script.src = src;
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  const extras = assetURL(script, 'tracker-extras.js');
  if (extras) vi.doMock(extras, () => ({ start }));
  await import('../public/tracker.js');
  await vi.dynamicImportSettled();
}
beforeEach(() => {
  vi.useFakeTimers();
  values = new Map();
  store = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => values.set(name, value)),
    removeItem: vi.fn((name: string) => values.delete(name)),
  };
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('sessionStorage', store);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
  vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(true) });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  history.replaceState({}, '', '/landing');
});
afterEach(() => {
  api()?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([{ consent: 'required' }, { identity: 'until-consent' }])(
  'collects nothing until explicit consent with %j and never replays earlier actions',
  async (data) => {
    const beacon = vi.mocked(navigator.sendBeacon);
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;
    const windowListen = vi.spyOn(window, 'addEventListener');
    const documentListen = vi.spyOn(document, 'addEventListener');
    await install(
      { ...data, autotrack: 'true', vitals: 'true' },
      'https://health.example/tracker.js?v=2026',
    );
    api().track('before_consent');
    history.pushState({}, '', '/users/123?secret=private');
    await api().flush();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      windowListen.mock.calls.filter(([type]) =>
        ['popstate', 'hashchange', 'pagehide', 'pageshow', 'scroll'].includes(type),
      ),
    ).toEqual([]);
    expect(
      documentListen.mock.calls.filter(([type]) => ['visibilitychange', 'click'].includes(type)),
    ).toEqual([]);
    expect(store.getItem.mock.calls).toEqual([[preference]]);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(document.head.querySelector('script')).toBeNull();
    expect(api().checkoutMetadata()).toEqual({});
    expect(api().diagnostics().queued).toBe(0);
    api().consent(true);
    api().consent(true);
    await vi.dynamicImportSettled();
    await api().flush();
    expect(
      batches()
        .flatMap((batch) => batch.events)
        .map((event) => [event.type, event.name, event.path]),
    ).toEqual([['pageview', undefined, '/users/:id']]);
    expect(batches()[0].visitor_id).toBeTruthy();
    expect(document.head.querySelector('script')?.src).toBe(
      'https://health.example/vitals.js?v=2026',
    );
    api().consent(false);
    expect(document.head.querySelector('script')).toBeNull();
    api().track('after_revoke');
    await api().flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    api().consent(true);
    await api().flush();
    expect(batches()[1].events).toHaveLength(1);
  },
);

it('uses only memory for cookieless visits while keeping a stable active document session', async () => {
  await install({ identity: 'cookieless' });
  api().track('action');
  await api().flush();
  const first = batches()[0];
  api().track('next');
  await api().flush();
  expect(batches()[1].session_id).toBe(first.session_id);
  expect(batches().every((batch) => !batch.visitor_id && !batch.visit_type)).toBe(true);
  expect(store.getItem.mock.calls.every(([name]) => name === preference)).toBe(true);
  expect(store.setItem).not.toHaveBeenCalled();
  api().stop();
  await install({ identity: 'cookieless' });
  await api().flush();
  expect(batches()[2].session_id).not.toBe(first.session_id);
});

it('persists own-visit exclusion, applies cross-tab undo, and keeps consent as a separate gate', async () => {
  values.set(preference, '1');
  await install({ consent: 'required' });
  expect(api().isIgnored()).toBe(true);
  api().consent(true);
  await api().flush();
  expect(fetch).not.toHaveBeenCalled();
  expect(store.getItem.mock.calls).toEqual([[preference]]);
  values.delete(preference);
  window.dispatchEvent(new StorageEvent('storage', { key: preference }));
  await api().flush();
  expect(api().isIgnored()).toBe(false);
  expect(batches()[0].events).toHaveLength(1);
  api().track('unsent');
  api().ignore();
  expect(values.get(preference)).toBe('1');
  expect(api().diagnostics().queued).toBe(0);
  await api().flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  api().stop();
  await install();
  expect(api().isIgnored()).toBe(true);
  api().consent(false);
  api().ignore(false);
  expect(values.has(preference)).toBe(false);
  await api().flush();
  expect(fetch).toHaveBeenCalledTimes(1);
  api().consent(true);
  await api().flush();
  expect(batches()[1].events.map((event) => event.name)).toEqual([undefined]);
  values.set(preference, '1');
  window.dispatchEvent(new StorageEvent('storage', { key: null }));
  expect(api().isIgnored()).toBe(true);
});

it('enforces exclusion in this document even when preference storage is blocked', async () => {
  store.getItem.mockImplementation(() => {
    throw new Error('blocked');
  });
  store.setItem.mockImplementation(() => {
    throw new Error('blocked');
  });
  store.removeItem.mockImplementation(() => {
    throw new Error('blocked');
  });
  await install();
  api().ignore(true);
  api().track('ignored');
  await api().flush();
  expect(fetch).not.toHaveBeenCalled();
  api().ignore(false);
  await api().flush();
  expect(batches()[0].events).toHaveLength(1);
  expect(batches()[0].visitor_id).toBeUndefined();
});

it('rejects stale Web Lock callbacks across revoke and regrant', async () => {
  const records: Array<() => void> = [];
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: vi.fn(
        (_key: string, record: () => void) =>
          new Promise<void>((resolve) =>
            records.push(() => {
              record();
              resolve();
            }),
          ),
      ),
    },
  });
  try {
    await install();
    api().track('stale');
    expect(api().checkoutMetadata()).toEqual({ app_health_page: '/landing' });
    api().consent(false);
    api().consent(true);
    records.forEach((record) => record());
    await api().flush();
    expect(batches()[0].events.map((event) => event.name)).toEqual([undefined]);
    expect(api().diagnostics().queued).toBe(0);
  } finally {
    Reflect.deleteProperty(navigator, 'locks');
  }
});

it('aborts pending delivery and does not retry a pre-revocation batch', async () => {
  await install();
  let signal: AbortSignal | undefined;
  vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) =>
      signal!.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const delivery = api().flush();
  api().ignore(true);
  expect(signal?.aborted).toBe(true);
  await delivery;
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(api().diagnostics()).toMatchObject({ retries: 0, accepted: 0, queued: 0 });
  api().ignore(false);
  await api().flush();
  expect(batches()[1].batch_id).not.toBe(batches()[0].batch_id);
});

it.each([
  ['?utm_source=launch&ref=referral&via=partner', 'launch'],
  ['?ref=referral&via=partner', 'referral'],
  ['?via=partner', 'partner'],
  ['?ref=private%40example.com&via=partner', 'partner'],
  ['?ref=https://example.com/private&via=alice%40example.com', 'search.example'],
])(
  'uses bounded source precedence for %s without sending arbitrary query values',
  async (query, expected) => {
    history.replaceState({}, '', `/landing${query}&secret=token`);
    vi.spyOn(document, 'referrer', 'get').mockReturnValue(
      'https://search.example/private?value=secret',
    );
    await install();
    await api().flush();
    expect(batches()[0].attribution?.source).toBe(expected);
    expect(JSON.stringify(batches())).not.toContain('token');
    expect(JSON.stringify(batches())).not.toContain('private');
    vi.setSystemTime(Date.now() + 1800001);
    api().track('later');
    await api().flush();
    expect(batches()[1].attribution?.source).toBe('');
  },
);

it('returns explicit sanitized checkout attribution without identity or additional network work', async () => {
  history.replaceState(
    {},
    '',
    '/orders/123?utm_source=launch&utm_campaign=summer&secret=private#token',
  );
  await install();
  const metadata = api().checkoutMetadata();
  expect(metadata).toEqual({
    app_health_source: 'launch',
    app_health_page: '/orders/:id',
    app_health_campaign: 'summer',
  });
  metadata.app_health_source = 'changed';
  expect(api().checkoutMetadata().app_health_source).toBe('launch');
  expect(fetch).not.toHaveBeenCalled();
  api().consent(false);
  expect(api().checkoutMetadata()).toEqual({});
  api().stop();
  const before = store.getItem.mock.calls.length;
  window.dispatchEvent(new StorageEvent('storage', { key: preference }));
  expect(store.getItem.mock.calls).toHaveLength(before);
});

it('preserves external history wrappers across pause and resume without recursion', async () => {
  const original = history.pushState;
  await install();
  const captured = history.pushState;
  const external = vi.fn(function (this: History, ...args: Parameters<History['pushState']>) {
    captured.apply(this, args);
  });
  history.pushState = external;
  api().ignore();
  expect(history.pushState).toBe(external);
  expect(vi.getTimerCount()).toBe(0);
  history.pushState({}, '', '/paused');
  expect(api().diagnostics().queued).toBe(0);
  api().ignore(false);
  history.pushState({}, '', '/resumed');
  await api().flush();
  expect(batches()[0].events.map((event) => event.path)).toEqual(['/paused', '/resumed']);
  expect(external).toHaveBeenCalledTimes(2);
  api().stop();
  // The host's wrapper remains installed. Restore the captured platform function for this fixture.
  expect(history.pushState).toBe(external);
  history.pushState = original;
});
it('settles concurrent flush callers when consent revocation aborts the shared fetch', async () => {
  await install();
  vi.mocked(fetch).mockImplementationOnce(async (_url, init) => {
    const signal = init!.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  });
  const first = api().flush();
  const second = api().flush();
  api().consent(false);
  await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  expect(api().diagnostics().queued).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
