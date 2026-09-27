import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OwnerAlertFeed } from '../src/OwnerAlertFeed.js';

afterEach(() => vi.unstubAllGlobals());

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
  ],
};

it('shows recent workspace alerts and total count without exposing submitted details', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(feed));
  vi.stubGlobal('fetch', fetch);
  render(<OwnerAlertFeed ownerToken="owner-token" />);
  expect(await screen.findByText('New feedback')).toBeTruthy();
  expect(screen.getByText('Waitlist join')).toBeTruthy();
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
