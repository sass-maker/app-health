// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserBatchV1 } from '@app-health/contracts';
import {
  committedIdentity,
  holdIdentityOpen,
  identityRecord,
  type StoredIdentity,
} from './tracker-storage.js';

const scope = 'ahk_pub_transactional';
const api = () => window.appHealth!;
const batches = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([, init]) => BrowserBatchV1.parse(JSON.parse(String(init?.body))));
const legacy = () => {
  const visitor = { id: crypto.randomUUID(), expires: Date.now() + 86400000 };
  return {
    visitor,
    visit: {
      id: crypto.randomUUID(),
      last: Date.now(),
      visitor_id: visitor.id,
      type: 'returning',
      attribution: {
        source: 'launch',
        medium: '',
        campaign: '',
        content: '',
        term: '',
        entry_path: '/landing',
      },
    },
  };
};
function seedLegacy(record: StoredIdentity) {
  localStorage.setItem(`h:${scope}:v`, JSON.stringify(record.visitor));
  localStorage.setItem(`h:${scope}:w`, JSON.stringify(record.visit));
}
async function install(consent = false) {
  vi.resetModules();
  const script = document.createElement('script');
  script.dataset.key = scope;
  script.dataset.endpoint = '/v1/browser';
  if (consent) script.dataset.consent = 'required';
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await import('../public/tracker.js');
}
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState({}, '', '/current?private=value');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 202 }));
});
afterEach(() => {
  api()?.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('imports a matching legacy identity once and preserves its original attribution and expiry', async () => {
  const original = legacy();
  seedLegacy(original);
  await install();
  await api().flush();
  expect(batches()[0]).toMatchObject({
    visitor_id: original.visitor.id,
    session_id: original.visit.id,
    visit_type: 'returning',
    attribution: original.visit.attribution,
  });
  expect(await identityRecord(scope)).toEqual(original);
  expect(localStorage.getItem(`h:${scope}:v`)).toBeNull();
  expect(localStorage.getItem(`h:${scope}:w`)).toBeNull();
  expect(localStorage.getItem(`h:${scope}:m`)).toBe('1');
  seedLegacy(legacy());
  api().stop();
  await install();
  await api().flush();
  expect(batches().at(-1)?.visitor_id).toBe(original.visitor.id);
  expect(batches().at(-1)?.session_id).toBe(original.visit.id);
});

it('does not resurrect a legacy identity after an IndexedDB-only reset', async () => {
  const original = legacy();
  seedLegacy(original);
  await install();
  await api().flush();
  api().stop();
  await identityRecord(scope, () => undefined);
  seedLegacy(original); // An old still-open tracker must not become the new authority.
  await install();
  await api().flush();
  expect(batches().at(-1)?.visitor_id).not.toBe(original.visitor.id);
  expect(batches().at(-1)?.session_id).not.toBe(original.visit.id);
});

it('keeps the canonical identity through a localStorage-only clear', async () => {
  await install();
  await api().flush();
  const first = batches()[0];
  api().stop();
  localStorage.clear();
  await install();
  await api().flush();
  expect(batches().at(-1)?.visitor_id).toBe(first.visitor_id);
  expect(batches().at(-1)?.session_id).toBe(first.session_id);
});

it('does not import a visit belonging to a different visitor', async () => {
  const original = legacy();
  original.visit.visitor_id = crypto.randomUUID();
  seedLegacy(original);
  await install();
  await api().flush();
  expect(batches()[0].visitor_id).toBe(original.visitor.id);
  expect(batches()[0].session_id).not.toBe(original.visit.id);
  expect(batches()[0].attribution?.source).toBe('');
  expect(batches()[0].attribution?.entry_path).toBe('/current');
});

it.each([
  ['visitor-expired', 0, 0, false],
  ['visit-at-thirty-minutes', 86400000, 1800000, true],
  ['visit-before-thirty-minutes', 86400000, 1799999, true],
] as const)(
  'preserves the existing lifetime boundary: %s',
  async (kind, expiry, age, sameVisitor) => {
    const original = legacy();
    original.visitor.expires = Date.now() + expiry;
    original.visit.last = Date.now() - age;
    await identityRecord(scope, () => original);
    await install();
    await api().flush();
    expect(batches()[0].visitor_id === original.visitor.id).toBe(sameVisitor);
    expect(batches()[0].session_id === original.visit.id).toBe(
      kind === 'visit-before-thirty-minutes',
    );
    expect((await identityRecord(scope))?.visitor.expires).toBe(
      sameVisitor ? original.visitor.expires : Date.now() + 90 * 86400000,
    );
  },
);

it('waits for durable identity before navigation handoff without waiting for the collector', async () => {
  const held = holdIdentityOpen();
  const beacon = vi.fn().mockReturnValue(true);
  vi.stubGlobal('Blob', NodeBlob);
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
  try {
    await install();
    api().track('next');
    const handoff = api().flushForNavigation!();
    await vi.waitFor(() => expect(held.waiting()).toBe(1));
    expect(beacon).not.toHaveBeenCalled();
    held.release();
    expect(await handoff).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    const batch = BrowserBatchV1.parse(
      JSON.parse(await (beacon.mock.calls[0][1] as NodeBlob).text()),
    );
    const committed = await committedIdentity(scope);
    expect(batch.visitor_id).toBe(committed.visitor.id);
    expect(batch.session_id).toBe(committed.visit.id);
    expect(batch.events.map((event) => event.name)).toEqual([undefined, 'next']);
  } finally {
    held.release();
    Reflect.deleteProperty(navigator, 'sendBeacon');
  }
});

it('aborts a pending identity write before publishing when consent is revoked', async () => {
  const put = IDBObjectStore.prototype.put;
  const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = put.apply(this, args);
    api().consent(false);
    return request;
  });
  await install();
  const client = api();
  await client.flush();
  write.mockRestore();
  expect(await identityRecord(scope)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
  expect(client.diagnostics().queued).toBe(0);
});

it('retains the committed session as unidentified memory after a later transaction failure', async () => {
  await install();
  await api().flush();
  const initial = batches()[0];
  vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
    throw new Error('Storage unavailable');
  });
  api().track('after_failure');
  await api().flush();
  api().track('still_unidentified');
  await api().flush();
  const following = batches().slice(1);
  expect(following).toHaveLength(2);
  expect(following.every((batch) => batch.session_id === initial.session_id)).toBe(true);
  expect(following.every((batch) => !batch.visitor_id && !batch.visit_type)).toBe(true);
  expect(following[0].attribution).toEqual(initial.attribution);
});

it('keeps legacy identity available when its first migration aborts before commit', async () => {
  const original = legacy();
  seedLegacy(original);
  const put = IDBObjectStore.prototype.put;
  const write = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args
  ) {
    const request = put.apply(this, args);
    api().consent(false);
    return request;
  });
  await install();
  await api().flush();
  write.mockRestore();
  expect(await identityRecord(scope)).toBeUndefined();
  expect(localStorage.getItem(`h:${scope}:m`)).toBe('0');
  expect(JSON.parse(localStorage.getItem(`h:${scope}:v`)!)).toEqual(original.visitor);
  api().stop();
  await install();
  await api().flush();
  expect(batches()[0]).toMatchObject({
    visitor_id: original.visitor.id,
    session_id: original.visit.id,
  });
});

it.each(['v', 'w'] as const)(
  'discards malformed legacy JSON in :%s without disabling the canonical store',
  async (key) => {
    const original = legacy();
    seedLegacy(original);
    localStorage.setItem(`h:${scope}:${key}`, '{malformed');
    await install();
    await api().flush();
    expect(batches()[0].visitor_id).toBeTruthy();
    expect(await identityRecord(scope)).toBeDefined();
    if (key === 'w') expect(batches()[0].visitor_id).toBe(original.visitor.id);
    expect(localStorage.getItem(`h:${scope}:v`)).toBeNull();
    expect(localStorage.getItem(`h:${scope}:w`)).toBeNull();
  },
);

it('retries interrupted legacy retirement without discarding the committed authority', async () => {
  const original = legacy();
  seedLegacy(original);
  const set = Storage.prototype.setItem;
  let interrupted = false;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (!interrupted && key === `h:${scope}:m` && value === '1') {
      interrupted = true;
      throw new Error('Retirement interrupted');
    }
    set.call(this, key, value);
  });
  await install();
  await api().flush();
  expect(batches()[0].visitor_id).toBe(original.visitor.id);
  expect((await identityRecord(scope))?.visitor).toEqual(original.visitor);
  expect(localStorage.getItem(`h:${scope}:m`)).toBe('0');
  await api().flush();
  expect(localStorage.getItem(`h:${scope}:m`)).toBe('1');
  expect(localStorage.getItem(`h:${scope}:v`)).toBeNull();
  expect(localStorage.getItem(`h:${scope}:w`)).toBeNull();
  expect(batches().every((batch) => batch.session_id === original.visit.id)).toBe(true);
});

it('drops callbacks from a stopped generation instead of creating or sending its identity', async () => {
  const held = holdIdentityOpen();
  await install();
  const client = api();
  client.track('stale');
  const flush = client.flush();
  await vi.waitFor(() => expect(held.waiting()).toBe(1));
  client.stop();
  held.release();
  await flush;
  expect(await identityRecord(scope)).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves event occurrence time while durable identity initialization is pending', async () => {
  const held = holdIdentityOpen();
  const occurredAt = Date.now();
  await install();
  api().track('before_boundary');
  const flush = api().flush();
  await vi.waitFor(() => expect(held.waiting()).toBe(1));
  vi.setSystemTime(occurredAt + 500);
  held.release();
  await flush;
  expect(batches()[0].events.every((event) => event.timestamp === occurredAt)).toBe(true);
});

it('does not access either identity store before required consent', async () => {
  const open = vi.spyOn(indexedDB, 'open');
  await install(true);
  api().track('pre_consent');
  await api().flush();
  expect(open).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  api().consent(true);
  await api().flush();
  expect(batches()[0].events.map((event) => event.name)).toEqual([undefined]);
});

it.each(['getItem', 'setItem'] as const)(
  'does not try IndexedDB to evade a blocked localStorage %s',
  async (method) => {
    const open = vi.spyOn(indexedDB, 'open');
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error('blocked');
    });
    await install();
    await api().flush();
    expect(open).not.toHaveBeenCalled();
    expect(batches()[0].visitor_id).toBeUndefined();
  },
);

it.each(['absent', 'throws', 'blocked'] as const)(
  'uses one unidentified memory session when IndexedDB is %s',
  async (mode) => {
    if (mode === 'absent') vi.stubGlobal('indexedDB', undefined);
    if (mode === 'throws')
      vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        throw new Error('SecurityError');
      });
    if (mode === 'blocked') {
      vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    }
    await install();
    const flush = api().flush();
    if (mode === 'blocked') await vi.advanceTimersByTimeAsync(2001);
    await flush;
    api().track('second');
    await api().flush();
    const [first, second] = batches();
    expect(first.session_id).toBe(second.session_id);
    expect(first.visitor_id).toBeUndefined();
    expect(second.visitor_id).toBeUndefined();
    expect(second.visit_type).toBeUndefined();
  },
);
