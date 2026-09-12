import { afterEach, expect, it, vi } from 'vitest';
import {
  createAnalyticsViewer,
  AnalyticsViewerError,
  type SharedAnalytics,
  type ViewerState,
  type ViewerVisibility,
} from '../src/viewer.js';
const token = `ahs_${'a'.repeat(43)}`;
const payload = {
  project: { name: 'Sample', environment: 'prod', private: 'strip' },
  live: { active: 3, measured_at: 1000, ttl_ms: 45000 },
  traffic: {
    from: 0,
    to: 1000,
    pageviews: 5,
    series: [{ timestamp: 0, pageviews: 5, path: '/secret' }],
  },
  source: 'local',
  sampled: false,
  updated_at: 1000,
  logs: ['strip'],
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
class Visibility implements ViewerVisibility {
  visibilityState = 'visible';
  listeners = new Set<() => void>();
  addEventListener(_event: string, listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_event: string, listener: () => void) {
    this.listeners.delete(listener);
  }
  set(value: string) {
    this.visibilityState = value;
    for (const fn of this.listeners) fn();
  }
}
function fixture(fetcher = vi.fn(async () => Response.json(payload))) {
  const visibility = new Visibility();
  const viewer = createAnalyticsViewer({
    origin: 'https://dashboard.test',
    token,
    visibility,
    fetch: fetcher,
  });
  const states: ViewerState[] = [];
  return { viewer, visibility, states, fetcher };
}
it('uses a scoped read-only request, shares in-flight reads and returns only allowed aggregate fields', async () => {
  const { viewer, fetcher } = fixture();
  const first = viewer.read();
  expect(viewer.read()).toBe(first);
  const data: SharedAnalytics = await first;
  expect(data.live.active).toBe(3);
  expect(JSON.stringify(data)).not.toMatch(/secret|strip/);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledWith(
    'https://dashboard.test/v1/shared/analytics',
    expect.objectContaining({
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  viewer.close();
  await expect(viewer.read()).rejects.toBeInstanceOf(AnalyticsViewerError);
});
it('rejects private/ingest keys and unsafe endpoint configuration', () => {
  for (const origin of [
    'file:///tmp/foo',
    'https://user:pass@example.com',
    'https://example.com/ingest',
    'https://example.com?key=secret',
  ])
    expect(() => createAnalyticsViewer({ origin, token })).toThrow();
  for (const invalid of ['ahk_pub_bad', 'ahk_native_bad', '', 'owner-key'])
    expect(() =>
      createAnalyticsViewer({ origin: 'https://example.com', token: invalid }),
    ).toThrow();
});
it('polls once for multiple subscribers, pauses/clears while hidden and permanently clears revoked links', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const stop = f.viewer.subscribe((state) => f.states.push(state));
  const stopSecond = f.viewer.subscribe(() => {
    throw new Error('host widget failure');
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.at(-1)?.kind).toBe('ready');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.visibility.set('hidden');
  expect(f.states.at(-1)).toEqual({ kind: 'paused' });
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.fetcher.mockResolvedValueOnce(Response.json({}, { status: 404 }));
  f.visibility.set('visible');
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.at(-1)).toEqual({ kind: 'unavailable', reason: 'revoked' });
  await vi.advanceTimersByTimeAsync(120000);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  await expect(f.viewer.read()).rejects.toMatchObject({ reason: 'revoked' });
  stop();
  stopSecond();
  f.viewer.close();
  expect(f.visibility.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('timeouts a stalled fetch, backs off and recovers without accepting a late response', async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => Response.json(payload));
  const f = fixture(fetcher);
  f.viewer.subscribe((state) => f.states.push(state));
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.states.at(-1)).toEqual({ kind: 'unavailable', reason: 'temporary' });
  finish(Response.json({ ...payload, live: { ...payload.live, active: 999 } }));
  await vi.advanceTimersByTimeAsync(19999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.states.at(-1)).toMatchObject({ kind: 'ready', data: { live: { active: 3 } } });
  f.viewer.close();
  expect(vi.getTimerCount()).toBe(0);
});
it('discards an obsolete response after visibility changes and aborts all reads on close', async () => {
  vi.useFakeTimers();
  let finish!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementation(async () => Response.json(payload));
  const f = fixture(fetcher);
  f.viewer.subscribe((state) => f.states.push(state));
  f.visibility.set('hidden');
  f.visibility.set('visible');
  finish(Response.json({ ...payload, live: { ...payload.live, active: 999 } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.states.filter((state) => state.kind === 'ready')).toHaveLength(1);
  expect(f.states.at(-1)).toMatchObject({ kind: 'ready', data: { live: { active: 3 } } });
  f.viewer.close();
  expect(f.states.at(-1)).toEqual({ kind: 'closed' });
  expect(f.visibility.listeners.size).toBe(0);
});
it('rejects malformed data instead of publishing misleading numbers', async () => {
  const f = fixture(vi.fn(async () => Response.json({ ...payload, live: { active: '3' } })));
  await expect(f.viewer.read()).rejects.toMatchObject({ reason: 'temporary' });
  f.viewer.close();
});
