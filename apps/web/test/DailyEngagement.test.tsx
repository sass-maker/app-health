import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DailyEngagement } from '../src/DailyEngagement.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flushFetch(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('rolls the default report forward at India midnight and on focus', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T18:29:59.000Z'));
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  await flushFetch();
  expect(String(fetch.mock.calls[0][0])).toContain('date=2026-09-27');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  await flushFetch();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(String(fetch.mock.calls[1][0])).toContain('date=2026-09-28');

  vi.setSystemTime(new Date('2026-09-29T18:31:00.000Z'));
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await flushFetch();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(String(fetch.mock.calls[2][0])).toContain('date=2026-09-29');
  vi.useRealTimers();
});

it('keeps a manually selected historical day until latest is chosen', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T18:29:59.000Z'));
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  await flushFetch();
  fireEvent.change(screen.getByLabelText('Report date'), { target: { value: '2026-09-25' } });
  await flushFetch();
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date('2026-09-28T18:31:00.000Z'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', { name: 'Show latest completed day' }));
  await flushFetch();
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(String(fetch.mock.calls[2][0])).toContain('date=2026-09-28');
  vi.useRealTimers();
});

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
    'Native sessions count only observed, unsampled native heartbeats; missing or sampled rows are unknown. API activity is unknown. Browser visitors count recognized browsers, not people.',
  ],
  products: [
    {
      catalog_id: 'atlas',
      app_id: 'app-atlas',
      name: 'Atlas',
      browser_visitors: 12,
      browser_visitors_applicability: 'applicable',
      cta_events: [
        { name: 'download_opened', count: 1, unique_browsers: 1, estimated: false },
        { name: 'signup_clicked', count: 20, unique_browsers: null, estimated: true },
      ],
      cta_status: 'measured',
      feedback_submitted: 0,
      newsletter_joins: null,
      newsletter_applicability: 'applicable',
      waitlist_joins: 2,
      waitlist_applicability: 'applicable',
      native_sessions: 3,
      native_sessions_applicability: 'applicable',
      api_activity: null,
      freshness: { browser_last_seen: null, log_last_seen: null },
      coverage: 'partial',
    },
    {
      catalog_id: 'beacon',
      app_id: 'app-beacon',
      name: 'Beacon',
      browser_visitors: null,
      browser_visitors_applicability: 'not_applicable',
      cta_events: [],
      cta_status: 'not_applicable',
      feedback_submitted: null,
      newsletter_joins: null,
      newsletter_applicability: 'not_applicable',
      waitlist_joins: null,
      waitlist_applicability: 'not_applicable',
      native_sessions: null,
      native_sessions_applicability: 'not_applicable',
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
  const summary = screen.getByLabelText('Daily evidence summary');
  expect(within(summary).getAllByText('1')).toHaveLength(2);
  expect(within(summary).getByText('product with browser visitor evidence')).toBeTruthy();
  expect(within(summary).getByText('product with measured primary actions')).toBeTruthy();
  expect(screen.getByLabelText('Daily evidence summary')).toHaveTextContent('Feedback: 0');
  expect(screen.getByLabelText('Daily evidence summary')).toHaveTextContent('Waitlist: 2');
  expect(screen.getByText(/cannot show products that have not been imported/)).toBeTruthy();
  const atlas = within(table).getByText('atlas').closest('tr')!;
  expect(within(atlas).getByText('0')).toBeTruthy();
  expect(within(atlas).getByText('download_opened')).toBeTruthy();
  expect(
    within(atlas).getByText((_, element) => element?.textContent === '1 browser · 1 action'),
  ).toBeTruthy();
  expect(
    screen.getAllByText(
      (_, element) => element?.textContent === 'Unknown browsers · Approx. 20 actions',
    ),
  ).toHaveLength(2);
  expect(within(atlas).getByText('Newsletter').parentElement).toHaveTextContent('Unknown');
  expect(within(atlas).getByText('Waitlist').parentElement).toHaveTextContent('2');
  expect(
    screen.getByText(/Native sessions count only observed, unsampled native heartbeats/),
  ).toBeTruthy();
  expect(within(atlas).getByText('3')).toBeTruthy();
  const mobile = screen.getByRole('list', { name: 'Daily engagement products' });
  const atlasCard = within(mobile).getByText('Atlas').closest('li')!;
  expect(within(atlasCard).getByText('Native sessions')).toBeTruthy();
  expect(within(atlasCard).getByText('3')).toBeTruthy();
  const beacon = within(table).getByText('beacon').closest('tr')!;
  expect(within(beacon).getAllByText('Unknown').length).toBeGreaterThan(1);
  expect(within(beacon).getByText('Native sessions').parentElement).toHaveTextContent(
    'Not applicable',
  );
  expect(within(beacon).getByText('Browser visitors').parentElement).toHaveTextContent(
    'Not applicable',
  );
  const beaconCard = within(mobile).getByText('Beacon').closest('li')!;
  const nativeMetric = within(beaconCard).getByText('Native sessions').parentElement!;
  expect(nativeMetric.querySelector('dd')?.textContent).toBe('Not applicable');
  const browserMetric = within(beaconCard).getByText('Browser visitors').parentElement!;
  expect(browserMetric.querySelector('dd')?.textContent).toBe('Not applicable');
  expect(within(beacon).getByText('Newsletter').parentElement).toHaveTextContent('Not applicable');
  expect(within(beacon).getByText('Waitlist').parentElement).toHaveTextContent('Not applicable');
  expect(fetch.mock.calls[0][0]).toContain('/v1/reports/daily-engagement?date=');
  fireEvent.change(screen.getByPlaceholderText('Search products'), { target: { value: 'Beacon' } });
  expect(within(table).queryByText('atlas')).toBeNull();
});

it('opens a source summary on its measured product rows and restores the full inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(report)),
  );
  render(<DailyEngagement ownerToken="owner" />);
  const table = await screen.findByRole('table');

  fireEvent.click(screen.getByRole('button', { name: /Visited/ }));
  expect(screen.getByText(/Showing 1 of 2 products with browser visitor evidence/)).toBeTruthy();
  expect(within(table).getByText('atlas')).toBeTruthy();
  expect(within(table).queryByText('beacon')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show all products' }));
  expect(within(table).getByText('atlas')).toBeTruthy();
  expect(within(table).getByText('beacon')).toBeTruthy();
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

it('shows the opted-in reason under an applicable unknown visitor count', async () => {
  const diagnosticReport = {
    ...report,
    products: report.products.map((product) =>
      product.catalog_id === 'atlas'
        ? {
            ...product,
            browser_visitors: null,
            browser_visitors_unknown_reason: 'telemetry_started_partway_through_day',
          }
        : product,
    ),
  };
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(diagnosticReport));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  const table = await screen.findByRole('table');
  const atlas = within(table).getByText('atlas').closest('tr')!;
  expect(within(atlas).getByText('Telemetry began partway through the day')).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('browser_visitor_unknown_reason=1');
});
