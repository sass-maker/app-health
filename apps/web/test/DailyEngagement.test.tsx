import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PortfolioBriefingV1 } from '@app-health/contracts';
import { DailyEngagement } from '../src/DailyEngagement.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function responseFor(input: RequestInfo | URL): Response {
  return Response.json(String(input).includes('/portfolio-briefing') ? briefing : report);
}

function requestsFor(fetch: ReturnType<typeof vi.fn>, route: string): string[] {
  return fetch.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(route));
}

it('keeps the latest completed India day current on midnight and focus, and preserves a manual date', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T18:29:59.000Z'));
  const fetch = vi.fn(async (input: RequestInfo | URL) => responseFor(input));
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  await flushPromises();
  expect(requestsFor(fetch, '/daily-engagement')[0]).toContain('date=2026-09-27');

  await act(async () => vi.advanceTimersByTimeAsync(1_100));
  await flushPromises();
  expect(requestsFor(fetch, '/daily-engagement')).toHaveLength(2);
  expect(requestsFor(fetch, '/daily-engagement')[1]).toContain('date=2026-09-28');

  fireEvent.change(screen.getByLabelText('Report date'), { target: { value: '2026-09-25' } });
  await flushPromises();
  vi.setSystemTime(new Date('2026-09-29T18:31:00.000Z'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(requestsFor(fetch, '/daily-engagement')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Show latest completed day' }));
  await flushPromises();
  expect(requestsFor(fetch, '/daily-engagement')).toHaveLength(4);
  expect(requestsFor(fetch, '/daily-engagement')[3]).toContain('date=2026-09-29');
});

it('shows browser counts, action intent, response receipts, sources, and applicable unknown states', async () => {
  expect(PortfolioBriefingV1.safeParse(briefing).success).toBe(true);
  const fetch = vi.fn(async (input: RequestInfo | URL) => responseFor(input));
  const onOpenProduct = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(
    <DailyEngagement
      ownerToken="owner"
      onOpenProduct={onOpenProduct}
      attentionItems={[
        {
          app_id: 'app-atlas',
          name: 'Atlas',
          label: 'Slow requests',
          p95_ms: 2_100,
          error_rate: 0.4,
        },
      ]}
      healthCoverage={{ measured: 1, applicable: 2, total: 2 }}
    />,
  );

  const table = await screen.findByRole('table');
  expect(screen.getByText('2 in scope')).toBeTruthy();
  expect(screen.getByText('Browser pageviews')).toBeTruthy();
  expect(
    await screen.findByRole('button', { name: 'Filter projects by Google source for 2026-09-27' }),
  ).toBeTruthy();
  expect(screen.getAllByText('100').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('Download intent')).toBeTruthy();
  expect(screen.getByText('Confirmed responses')).toBeTruthy();
  expect(screen.getByText('Measured health issues')).toBeTruthy();
  expect(screen.getByText('Atlas: Slow requests')).toBeTruthy();

  const atlas = within(table).getByText('atlas').closest('tr')!;
  expect(within(atlas).getByText('12')).toBeTruthy();
  expect(within(atlas).getByText('Approx. 21 events')).toBeTruthy();
  expect(within(atlas).getAllByText('2').length).toBeGreaterThan(0);
  expect(
    within(table).getByRole('button', { name: 'Open Google source for 2026-09-27' }),
  ).toBeTruthy();

  const beacon = within(table).getByText('beacon').closest('tr')!;
  expect(within(beacon).getAllByText('Not applicable').length).toBeGreaterThan(0);
  expect(within(beacon).getAllByText('Unknown').length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('button', { name: /With browser data/ }));
  expect(within(table).getByText('atlas')).toBeTruthy();
  expect(within(table).queryByText('beacon')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /All 2/ }));
  expect(within(table).getByText('beacon')).toBeTruthy();

  fireEvent.click(within(table).getByRole('button', { name: 'Open Google source for 2026-09-27' }));
  expect(onOpenProduct).toHaveBeenCalledWith('app-atlas', 'analytics', 'google.com', '2026-09-27');
  expect(requestsFor(fetch, '/daily-engagement')[0]).toContain('browser_visitor_unknown_reason=1');
});

it('makes every breakout available when more than two projects grow', async () => {
  const products = [0, 1, 2].map((index) => ({
    ...report.products[0],
    app_id: `growth-${index}`,
    catalog_id: `growth-${index}`,
    name: `Growing product ${index}`,
    browser_visitors: 30 + index * 10,
  }));
  const daily = { ...report, product_count: products.length, products };
  const insights = {
    ...briefing,
    products: products.map((product) => ({
      ...briefing.products[0],
      app_id: product.app_id,
      catalog_id: product.catalog_id,
      name: product.name,
      previous_browser_visitors: 10,
      browser_change: product.browser_visitors - 10,
      breakout: true,
    })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(String(input).includes('/portfolio-briefing') ? insights : daily),
    ),
  );
  render(<DailyEngagement ownerToken="owner" />);
  const expand = await screen.findByRole('button', { name: 'Show all 3 breakouts' });
  expect(screen.getAllByText('Growth', { exact: true })).toHaveLength(2);
  fireEvent.click(expand);
  expect(screen.getAllByText('Growth', { exact: true })).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'Show the top two' }));
  expect(screen.getAllByText('Growth', { exact: true })).toHaveLength(2);
});

it('labels missing health coverage separately from measured issue count', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => responseFor(input)),
  );
  render(<DailyEngagement ownerToken="owner" attentionItems={[]} />);
  await screen.findByRole('table');
  expect(screen.getByText('No measured issues')).toBeTruthy();
  expect(screen.getByText('Coverage unknown · latest 24 hours')).toBeTruthy();
});

it('times out a hung source response body without blocking the daily report, then retries', async () => {
  vi.useFakeTimers();
  let portfolioRequests = 0;
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!String(input).includes('/portfolio-briefing'))
      return Promise.resolve(Response.json(report));
    portfolioRequests += 1;
    if (portfolioRequests > 1) return Promise.resolve(Response.json(briefing));
    const signal = init?.signal;
    const response = {
      ok: true,
      json: () =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    } as Response;
    return Promise.resolve(response);
  });
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  await flushPromises();
  await act(async () => vi.advanceTimersByTimeAsync(10_001));
  expect(screen.getByRole('table')).toBeTruthy();
  expect(screen.getByText('2 in scope')).toBeTruthy();
  expect(screen.getByText(/Sources and comparisons unavailable/)).toBeTruthy();
  expect(screen.getByRole('table')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry insights' }));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(
    screen.getByRole('button', { name: 'Filter projects by Google source for 2026-09-27' }),
  ).toBeTruthy();
});

it('shows a retryable daily-report error without losing selected date behavior', async () => {
  const dailyResponses: Response[] = [new Response(null, { status: 503 }), Response.json(report)];
  const fetch = vi.fn(async (input: RequestInfo | URL) =>
    String(input).includes('/portfolio-briefing')
      ? Response.json(briefing)
      : (dailyResponses.shift() ?? Response.json(report)),
  );
  vi.stubGlobal('fetch', fetch);
  render(<DailyEngagement ownerToken="owner" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('503');
  fireEvent.click(screen.getByRole('button', { name: 'Retry daily report' }));
  await waitFor(() => expect(screen.getByText('2 in scope')).toBeTruthy());
});

const briefing = {
  date: '2026-09-27',
  timezone: 'Asia/Kolkata',
  generated_at: Date.UTC(2026, 8, 28),
  products: [
    {
      app_id: 'app-atlas',
      catalog_id: 'atlas',
      name: 'Atlas',
      pageviews: 100,
      top_sources: [{ name: 'google.com', pageviews: 48, share: 0.48 }],
      sources_status: 'measured',
      source_estimated: false,
      previous_browser_visitors: 10,
      browser_change: 2,
      breakout: true,
      comparison_reason: 'Comparable day',
    },
    {
      app_id: 'app-beacon',
      catalog_id: 'beacon',
      name: 'Beacon',
      pageviews: null,
      top_sources: [],
      sources_status: 'not_applicable',
      source_estimated: false,
      previous_browser_visitors: null,
      browser_change: null,
      breakout: false,
      comparison_reason: 'No browser surface',
    },
  ],
  sources: [
    { name: 'google.com', pageviews: 48, share: 0.48 },
    { name: 'No referrer', pageviews: 52, share: 0.52 },
  ],
  comparison_note: 'Comparable coverage for Atlas only.',
  filter_note: 'Referrer values follow the canonical source filter.',
};

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
      server_requests_applicability: 'applicable',
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
      server_requests_applicability: 'not_applicable',
      freshness: { browser_last_seen: null, log_last_seen: null },
      coverage: 'unknown',
    },
  ],
};
