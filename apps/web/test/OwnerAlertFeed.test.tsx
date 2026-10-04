import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerAlertFeed } from '../src/OwnerAlertFeed.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const feed = {
  generated_at: Date.UTC(2026, 8, 28),
  total_count: 9,
  entries: [
    {
      id: 'feedback-1',
      app_id: 'app-atlas',
      catalog_id: 'atlas',
      project_name: 'Atlas',
      event: 'feedback.submitted',
      timestamp: Date.UTC(2026, 8, 28, 8),
    },
    {
      id: 'waitlist-1',
      app_id: 'app-beacon',
      catalog_id: 'beacon',
      project_name: 'Beacon',
      event: 'waitlist.join',
      timestamp: Date.UTC(2026, 8, 28, 7),
    },
    {
      id: 'newsletter-1',
      app_id: 'app-catalog',
      catalog_id: 'catalog',
      project_name: 'Catalog',
      event: 'newsletter.subscribe',
      timestamp: Date.UTC(2026, 8, 28, 6),
    },
  ],
};

it('shows recent workspace alerts and total count without exposing submitted details', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json(feed),
  );
  vi.stubGlobal('fetch', fetch);
  render(<OwnerAlertFeed ownerToken="owner-token" />);
  expect(await screen.findByText('New feedback')).toBeTruthy();
  expect(screen.getByText('Waitlist join')).toBeTruthy();
  expect(screen.getByText('Newsletter subscription')).toBeTruthy();
  expect(screen.getByText('9 in retention')).toBeTruthy();
  expect(screen.getByText(/Atlas/)).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toBe('/v1/workspace/alerts');
  expect(fetch.mock.calls[0][1]).toMatchObject({
    headers: { authorization: 'Bearer owner-token' },
  });
  expect(screen.queryByText(/email|message|submission/i)).toBeNull();
  fireEvent(window, new Event('focus'));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it('refreshes the feed and gives a retryable error when unavailable', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(feed));
  vi.stubGlobal('fetch', fetch);
  render(<OwnerAlertFeed ownerToken="owner-token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('503');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh alerts' }));
  await waitFor(() => expect(screen.getByText('9 in retention')).toBeTruthy());
});

it('shows production failures and degradation with explicit source labels', async () => {
  const healthFeed = {
    generated_at: feed.generated_at,
    total_count: 2,
    entries: [
      {
        id: 'picker-failed',
        app_id: 'app-memes',
        catalog_id: 'meme-lab',
        project_name: 'Meme Lab',
        event: 'recommendation.failed',
        level: 'error',
        source: 'browser',
        timestamp: Date.UTC(2026, 9, 4, 4),
      },
      {
        id: 'picker-degraded',
        app_id: 'app-memes',
        catalog_id: 'meme-lab',
        project_name: 'Meme Lab',
        event: 'recommendation.degraded',
        level: 'warn',
        source: 'server',
        timestamp: Date.UTC(2026, 9, 4, 3),
      },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(healthFeed)),
  );
  render(<OwnerAlertFeed ownerToken="owner-token" />);
  expect(await screen.findByText('Production failure')).toBeTruthy();
  expect(screen.getByText('Service degraded')).toBeTruthy();
  expect(screen.getByText(/browser recommendation.failed/)).toBeTruthy();
  expect(screen.getByText(/server recommendation.degraded/)).toBeTruthy();
  expect(screen.getByText('2 in retention')).toBeTruthy();
  expect(screen.queryByText('Newsletter subscription')).toBeNull();
});

it('times out a hung fetch, recovers on manual retry, and ignores its late response', async () => {
  vi.useFakeTimers();
  let resolveHungFetch!: (response: Response) => void;
  const hungResponse = new Promise<Response>((resolve) => {
    resolveHungFetch = resolve;
  });
  const fetch = vi
    .fn((_input: RequestInfo | URL, _init?: RequestInit) => hungResponse)
    .mockReturnValueOnce(hungResponse)
    .mockResolvedValueOnce({ ok: true, json: async () => feed } as Response);
  vi.stubGlobal('fetch', fetch);
  const view = render(<OwnerAlertFeed ownerToken="owner-token" />);

  expect(screen.getByRole('status', { name: 'Loading alerts' })).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect((fetch.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
  expect(screen.queryByRole('status', { name: 'Loading alerts' })).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alerts' }));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  expect(screen.getByText('9 in retention')).toBeTruthy();
  expect(vi.getTimerCount()).toBe(1);

  resolveHungFetch({
    ok: true,
    json: async () => ({
      ...feed,
      entries: [{ ...feed.entries[0], project_name: 'Late response' }],
    }),
  } as Response);
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  expect(screen.getByText(/Atlas/)).toBeTruthy();
  expect(screen.queryByText(/Late response/)).toBeNull();

  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('times out while reading a response body and aborts the request', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      json: () => new Promise<unknown>(() => {}),
    } as Response),
  );
  vi.stubGlobal('fetch', fetch);
  const view = render(<OwnerAlertFeed ownerToken="owner-token" />);
  await act(async () => {
    await Promise.resolve();
  });
  const signal = (fetch.mock.calls[0]?.[1] as RequestInit).signal;

  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });

  expect(signal?.aborted).toBe(true);
  expect(screen.queryByRole('status', { name: 'Loading alerts' })).toBeNull();
  expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('aborts a pending request and clears its timeout when unmounted', () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}),
  );
  vi.stubGlobal('fetch', fetch);
  const view = render(<OwnerAlertFeed ownerToken="owner-token" />);
  const signal = (fetch.mock.calls[0]?.[1] as RequestInit).signal;

  expect(vi.getTimerCount()).toBe(2);
  view.unmount();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
