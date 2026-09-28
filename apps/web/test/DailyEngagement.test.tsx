import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DailyEngagement } from '../src/DailyEngagement.js';

afterEach(() => vi.unstubAllGlobals());

const report = {
  schema: 'app-health.daily-engagement.v1',
  schema_version: 1,
  generated_at: Date.UTC(2026, 8, 28),
  date: '2026-09-27',
  timezone: 'Asia/Kolkata',
  from: Date.UTC(2026, 8, 27),
  to: Date.UTC(2026, 8, 28),
  product_count: 2,
  sampled: true,
  notes: [
    'No qualified primary CTA events are reportable for 2026-09-27; counts are unknown.',
    'Native sessions and API activity are unknown; this report counts recognized browsers, not people.',
  ],
  products: [
    {
      catalog_id: 'atlas',
      app_id: 'app-atlas',
      name: 'Atlas',
      browser_visitors: 12,
      cta_events: [
        { name: 'download_opened', count: 4, estimated: false },
        { name: 'signup_clicked', count: 20, estimated: true },
      ],
      cta_status: 'measured',
      feedback_submitted: 0,
      newsletter_joins: null,
      waitlist_joins: 2,
      native_sessions: null,
      api_activity: null,
      freshness: { browser_last_seen: null, log_last_seen: null },
      coverage: 'partial',
    },
    {
      catalog_id: 'beacon',
      app_id: 'app-beacon',
      name: 'Beacon',
      browser_visitors: null,
      cta_events: [],
      cta_status: 'not_applicable',
      feedback_submitted: null,
      newsletter_joins: null,
      waitlist_joins: null,
      native_sessions: null,
      api_activity: null,
      freshness: { browser_last_seen: null, log_last_seen: null },
      coverage: 'unknown',
    },
  ],
};

it('keeps unknown separate from zero and flags incomplete 55-product scope', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  const table = await screen.findByRole('table');
  expect(screen.getByText('2/55 imported')).toBeTruthy();
  expect(screen.getByText(/cannot show products that have not been imported/)).toBeTruthy();
  const atlas = within(table).getByText('atlas').closest('tr')!;
  expect(within(atlas).getByText('0')).toBeTruthy();
  expect(within(atlas).getByText('download_opened')).toBeTruthy();
  expect(within(atlas).getByText('4')).toBeTruthy();
  expect(screen.getAllByText('Approx. 20')).toHaveLength(2);
  expect(screen.getByText(/Native sessions and API activity are unknown/)).toBeTruthy();
  const beacon = within(table).getByText('beacon').closest('tr')!;
  expect(within(beacon).getAllByText('Unknown').length).toBeGreaterThan(2);
  expect(within(beacon).getByText('Not applicable')).toBeTruthy();
  expect(fetch.mock.calls[0][0]).toContain('/v1/reports/daily-engagement?date=');
  fireEvent.change(screen.getByPlaceholderText('Search products'), { target: { value: 'Beacon' } });
  expect(within(table).queryByText('atlas')).toBeNull();
});

it('shows a retryable error when the owner report is unavailable', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json(report));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('503');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh daily engagement' }));
  await waitFor(() => expect(screen.getByText('2/55 imported')).toBeTruthy());
});
