import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicAnalyticsView } from '../src/PublicAnalyticsView.js';
import { usePublicAnalytics } from '../src/usePublicAnalytics.js';

const tokenA = `ahs_${'a'.repeat(43)}`;
const tokenB = `ahs_${'b'.repeat(43)}`;
const payload = {
  project: { name: 'Lifecycle app', environment: 'production' },
  live: { active: 7, measured_at: 1_700_000_000_000, ttl_ms: 45_000 },
  traffic: {
    pageviews: 28,
    from: 1_699_913_600_000,
    to: 1_700_000_000_000,
    series: [{ timestamp: 1_699_999_000_000, pageviews: 28 }],
  },
  source: 'local' as const,
  sampled: false,
  updated_at: 1_700_000_000_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function setLocation(token: string) {
  window.history.replaceState({}, '', `#token=${token}`);
}

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
let hidden = false;

function setVisibility(value: 'visible' | 'hidden') {
  hidden = value === 'hidden';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
}

const parseProbe = (body: unknown) => body as typeof payload;

function Probe({ token }: { token: string | null }) {
  const { state, retry } = usePublicAnalytics(token, parseProbe);
  return (
    <div>
      <output data-testid="state">
        {state.kind}:
        {state.kind === 'ready'
          ? `${state.data.project.name}:${state.refreshing}:${state.stale}`
          : ''}
      </output>
      <button onClick={retry}>retry</button>
    </div>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else Reflect.deleteProperty(document, 'visibilityState');
  setLocation('');
});

it('starts a fresh request on resume and ignores the stale request finalizer', async () => {
  vi.useFakeTimers();
  setLocation(tokenA);
  setVisibility('visible');
  const first = deferred<Response>();
  const second = deferred<Response>();
  const fetch = vi.fn((_: string, init: RequestInit) => {
    expect(init.signal).toBeTruthy();
    return fetch.mock.calls.length === 1 ? first.promise : second.promise;
  });
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  await flush();
  expect(fetch).toHaveBeenCalledTimes(1);

  setVisibility('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  setVisibility('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);

  first.resolve(response(payload));
  await flush();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetch).toHaveBeenCalledTimes(2);
  second.resolve(response(payload));
  await flush();
});

it('keeps old metrics during a timeout and marks the report stale before retrying', async () => {
  vi.useFakeTimers();
  setLocation(tokenA);
  setVisibility('visible');
  const hanging = deferred<Response>();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(payload))
    .mockReturnValueOnce(hanging.promise)
    .mockResolvedValueOnce(response(payload));
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  await flush();
  expect(screen.getAllByText('28').length).toBeGreaterThan(0);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await flush();
  expect(screen.getAllByText('28').length).toBeGreaterThan(0);
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  await flush();
  expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it('stops polling and clears data after revocation', async () => {
  vi.useFakeTimers();
  setLocation(tokenA);
  setVisibility('visible');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(payload))
    .mockResolvedValueOnce(response({}, 404));
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  await flush();
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await flush();
  expect(screen.getByRole('alert')).toHaveTextContent(/link is unavailable/i);
  expect(screen.queryByText('Lifecycle app')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('switches to the new hash token and never reuses the old authorization header', async () => {
  vi.useFakeTimers();
  setLocation(tokenA);
  setVisibility('visible');
  const fetch = vi.fn().mockResolvedValue(response(payload));
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  await flush();
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
    `Bearer ${tokenA}`,
  );

  setLocation(tokenB);
  act(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await flush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
    `Bearer ${tokenB}`,
  );
  expect(screen.getAllByText('Lifecycle app').length).toBeGreaterThan(0);
});

it('keeps the report visible while polling and during a transient failure', async () => {
  vi.useFakeTimers();
  setVisibility('visible');
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(payload))
    .mockRejectedValueOnce(new Error('offline'));
  vi.stubGlobal('fetch', fetch);
  render(<Probe token={tokenA} />);
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:false:false');
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:false:true');
  expect(screen.getByTestId('state')).not.toHaveTextContent('loading');
});

it('marks retained metrics stale while the tab is hidden', async () => {
  vi.useFakeTimers();
  setVisibility('visible');
  const resumed = deferred<Response>();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response(payload))
    .mockReturnValueOnce(resumed.promise);
  vi.stubGlobal('fetch', fetch);
  render(<Probe token={tokenA} />);
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:false:false');

  setVisibility('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:false:true');

  setVisibility('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:true:true');
  resumed.resolve(response(payload));
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('ready:Lifecycle app:false:false');
});

it('invalidates the previous token scope synchronously', async () => {
  vi.useFakeTimers();
  setVisibility('visible');
  const first = deferred<Response>();
  const second = deferred<Response>();
  const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal('fetch', fetch);
  const view = render(<Probe token={tokenA} />);
  await flush();
  first.resolve(response(payload));
  await flush();
  expect(screen.getByTestId('state')).toHaveTextContent('Lifecycle app');
  view.rerender(<Probe token={tokenB} />);
  expect(screen.getByTestId('state')).toHaveTextContent('loading:');
  expect(screen.getByTestId('state')).not.toHaveTextContent('Lifecycle app');
  second.resolve(response(payload));
  await flush();
});
