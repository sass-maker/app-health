import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBrowserReport, useWorkspaceAnalytics } from '../src/useAnalytics.js';

const live = {
  measured_at: 1,
  ttl_ms: 45_000,
  total: 1,
  projects: [{ app_id: 'app', environment_id: 'env', active: 1 }],
};
const summary = {
  enabled: true,
  source: 'local',
  sampled: false,
  stream: true,
  projects: [{ app_id: 'app', environment_id: 'env', pageviews: 1, events: 1 }],
  live,
};
const report = {
  from: 1,
  to: 2,
  sampled: false,
  source: 'local',
  series: [],
  pages: [],
  sources: [],
  events: [],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('analytics visibility lifecycle', () => {
  it('pauses the workspace request and socket, then resumes with one fresh connection', async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const fetch = vi.fn(async () => Response.json(summary));
    vi.stubGlobal('fetch', fetch);
    class Socket {
      static instances: Socket[] = [];
      onopen?: () => void;
      onclose?: (event: { code?: number }) => void;
      close = vi.fn();
      constructor() {
        Socket.instances.push(this);
      }
    }
    vi.stubGlobal('WebSocket', Socket);

    const view = renderHook(() => useWorkspaceAnalytics('owner'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(Socket.instances).toHaveLength(1);

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(Socket.instances[0].close).toHaveBeenCalledOnce();
    act(() => Socket.instances[0].onclose?.({ code: 1006 }));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(Socket.instances).toHaveLength(1);

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(Socket.instances).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(Socket.instances[1].close).toHaveBeenCalledOnce();
  });

  it('aborts hidden report work and performs a new load after becoming visible', async () => {
    let hidden = true;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return Response.json(report);
    });
    vi.stubGlobal('fetch', fetch);

    const view = renderHook(() => useBrowserReport('owner', '1h', '', '', ''));
    expect(fetch).not.toHaveBeenCalled();

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2));

    view.unmount();
  });

  it('does not let an older report response release the resumed poll guard', async () => {
    vi.useFakeTimers();
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const resolvers: Array<(response: Response) => void> = [];
    const fetch = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((resolve, reject) => {
          resolvers.push(resolve);
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetch);

    const view = renderHook(() => useBrowserReport('owner', '1h', '', '', ''));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledOnce();

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(7_999));
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers[1](Response.json(report));
    view.unmount();
  });

  it('rejects malformed summaries and recovers on reload', async () => {
    let malformed = true;
    const fetch = vi.fn(async () => Response.json(malformed ? { live } : summary));
    vi.stubGlobal('fetch', fetch);

    const view = renderHook(() => useWorkspaceAnalytics('owner'));
    await waitFor(() => expect(view.result.current.error).toBe('Analytics is unavailable.'));
    malformed = false;
    act(() => view.result.current.reload());
    await waitFor(() => expect(view.result.current.data).toEqual(summary));
    view.unmount();
  });

  it('times out a stuck report request and recovers on retry', async () => {
    vi.useFakeTimers();
    let stuck = true;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (stuck)
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted'))),
        );
      return Response.json(report);
    });
    vi.stubGlobal('fetch', fetch);
    const view = renderHook(() => useBrowserReport('owner', '1h', '', '', ''));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(view.result.current.error).toBe('Report request timed out. Please try again.');
    stuck = false;
    act(() => view.result.current.reload());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.result.current.report).toEqual(report);
    view.unmount();
  });

  it('clears owner data and ignores the previous owner response', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetch = vi.fn(
      async () => await new Promise<Response>((resolve) => resolvers.push(resolve)),
    );
    vi.stubGlobal('fetch', fetch);
    const view = renderHook(({ owner }) => useWorkspaceAnalytics(owner), {
      initialProps: { owner: 'first' },
    });
    await act(async () => Promise.resolve());
    expect(fetch).toHaveBeenCalledOnce();
    view.rerender({ owner: 'second' });
    expect(view.result.current.data).toBeNull();
    resolvers[0](Response.json(summary));
    await act(async () => Promise.resolve());
    expect(view.result.current.data).toBeNull();
    resolvers[1](Response.json(summary));
    await waitFor(() => expect(view.result.current.data).toEqual(summary));
    view.unmount();
  });
});
