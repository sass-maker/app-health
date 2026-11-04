import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TrafficQuality } from '../src/TrafficQuality.js';
import { selectWorkspace } from '../src/lib/workspace-scope.js';

const report = {
  from: Date.UTC(2026, 10, 1),
  to: Date.UTC(2026, 10, 2),
  source: 'analytics-engine' as const,
  sampled: false,
  series: [{ timestamp: Date.UTC(2026, 10, 1), pageviews: 12, events: 3 }],
  pages: [],
  sources: [],
  events: [],
  sessions: 4,
};
const props = {
  ownerToken: 'owner',
  appId: 'app-one',
  environmentId: 'env-one',
  report,
  filtered: false,
  period: 'range:24h',
};
const response = (patch = {}) => ({
  app_id: 'app-one',
  environment_id: 'env-one',
  from: Date.UTC(2026, 10, 1),
  to: Date.UTC(2026, 10, 2),
  generated_at: report.to + 1000,
  time_basis: 'receipt_time',
  qa_internal: 'not_separately_identified',
  bots: {
    status: 'observed',
    pageview_attempts: 7,
    cloudflare_verified: 4,
    recognized_user_agent: 3,
    estimated: true,
    coverage: 'partial',
  },
  ...patch,
});
afterEach(() => {
  vi.restoreAllMocks();
  act(() => selectWorkspace(''));
});

it('shows ordinary pageviews immediately while bot counters load independently, then labels partial estimates and detector counts', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<TrafficQuality {...props} />);
  const card = screen.getByLabelText('Traffic quality');
  expect(within(card).getByText('12')).toBeVisible();
  expect(within(card).getByText('Loading bot counters…')).toBeVisible();
  expect(fetcher.mock.calls[0][0]).toContain(`from=${report.from}&to=${report.to}`);
  await act(async () => finish(Response.json(response())));
  expect(within(card).getByText('7')).toBeVisible();
  expect(within(card).getByText('estimated · partial coverage')).toBeVisible();
  expect(within(card).getByText(/Cloudflare verified: 4/)).toHaveTextContent(
    'Recognized user agent: 3',
  );
  expect(within(card).getByText('Not separately identified')).toBeVisible();
  expect(within(card).getByText(/These are not verified humans/)).toBeVisible();
  fireEvent.click(within(card).getByText('How these counts work'));
  expect(within(card).getByText(/appHealth.ignore/)).toBeVisible();
});

it('isolates failed bot loads, retries them, and never displays unknown as zero', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json(response({ bots: { status: 'unknown', reason: 'no_records' } })),
    );
  render(<TrafficQuality {...props} />);
  await screen.findByText('Bot counters could not load.');
  expect(screen.getByText('12')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Retry traffic quality' }));
  await screen.findByText('Unknown');
  expect(screen.getByText(/Unknown does not mean zero/)).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('suppresses queries and comparison counts for segment or named event selections', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const view = render(<TrafficQuality {...props} filtered />);
  expect(screen.getByText(/unavailable for segment or named event filters/)).toBeVisible();
  expect(screen.queryByText('12')).toBeNull();
  expect(screen.queryByText('Not detected as bots')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(Response.json(response()));
  view.rerender(<TrafficQuality {...props} report={{ ...report }} />);
  await screen.findByText('7');
  view.rerender(<TrafficQuality {...props} filtered />);
  expect(screen.queryByText('7')).toBeNull();
});

it.each([
  { appId: 'app-two' },
  { environmentId: 'env-two' },
  { report: { ...report, from: Date.UTC(2026, 10, 2), to: Date.UTC(2026, 10, 3) } },
])('aborts and discards late replies after a scope or window change %s', async (patch) => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) => new Promise((resolve) => pending.push({ resolve, signal: init!.signal! })),
  );
  const view = render(<TrafficQuality {...props} />);
  view.rerender(<TrafficQuality {...props} {...patch} report={patch.report ?? { ...report }} />);
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[0].resolve(Response.json(response())));
  expect(screen.queryByText('7')).toBeNull();
  const next = {
    ...response(),
    app_id: patch.appId ?? 'app-one',
    environment_id: patch.environmentId ?? 'env-one',
    from: patch.report?.from ?? report.from,
    to: patch.report?.to ?? report.to,
    bots: { ...response().bots, pageview_attempts: 19, cloudflare_verified: 16 },
  };
  await act(async () => pending[1].resolve(Response.json(next)));
  expect(screen.getByText('19')).toBeVisible();
});

it('aborts and clears traffic quality across workspace changes', async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url, init) => new Promise((resolve) => pending.push({ resolve, signal: init!.signal! })),
  );
  const view = render(<TrafficQuality {...props} />);
  act(() => selectWorkspace('workspace-two'));
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[0].resolve(Response.json(response())));
  expect(screen.queryByText('7')).toBeNull();
  expect(screen.queryByText('12')).toBeNull();
  expect(pending).toHaveLength(1);
  view.rerender(<TrafficQuality {...props} report={{ ...report }} />);
  await act(async () =>
    pending[1].resolve(
      Response.json(response({ bots: { status: 'unknown', reason: 'no_records' } })),
    ),
  );
  expect(screen.getByText('Unknown')).toBeVisible();
});

it('rejects wrong-scope and malformed auxiliary responses', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response({ app_id: 'other-app' })));
  render(<TrafficQuality {...props} />);
  await waitFor(() => expect(screen.getByText('Bot counters could not load.')).toBeVisible());
  expect(screen.queryByText('7')).toBeNull();
  expect(screen.getByText('12')).toBeVisible();
});

it('labels historical browser pageviews without claiming that known bots were excluded', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(
      response({ from: 1000, to: 2000, bots: { status: 'unknown', reason: 'no_records' } }),
    ),
  );
  render(<TrafficQuality {...props} report={{ ...report, from: 1000, to: 2000 }} />);
  expect(screen.getByText('Browser pageviews')).toBeVisible();
  expect(screen.queryByText('Not detected as bots')).toBeNull();
  expect(screen.getByText(/may include known bots/)).toBeVisible();
  await screen.findByText('Unknown');
});

it('rejects detector totals that do not reconcile', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(response({ bots: { ...response().bots, pageview_attempts: 8 } })),
  );
  render(<TrafficQuality {...props} />);
  await screen.findByText('Bot counters could not load.');
  expect(screen.queryByText('8')).toBeNull();
});

it('waits explicitly for a current analytics report without pretending to load bot counters', () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(<TrafficQuality {...props} report={null} />);
  expect(
    screen.getByText('Load the analytics report to view bot counters for its period.'),
  ).toBeVisible();
  expect(screen.queryByText('Loading bot counters…')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['http', 'unavailable', 'invalid_response'] as const)(
  'retains and labels the previous reading while the same rolling period refreshes and fails with %s',
  async (failure) => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(response()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const view = render(<TrafficQuality {...props} />);
    await screen.findByText('7');
    const shifted = { ...report, from: report.from + 60_000, to: report.to + 60_000 };
    view.rerender(<TrafficQuality {...props} report={shifted} />);
    expect(screen.getByText('7')).toBeVisible();
    expect(screen.getByText('Refreshing bot counters. Showing previous reading.')).toBeVisible();
    expect(screen.queryByText('Loading bot counters…')).toBeNull();
    expect(screen.getByText(/Previous bot window:/)).toBeVisible();
    expect(
      document.querySelector(`time[datetime="${new Date(report.to).toISOString()}"]`),
    ).not.toBeNull();
    expect(
      document.querySelector(`time[datetime="${new Date(report.to + 1000).toISOString()}"]`),
    ).not.toBeNull();
    expect(fetcher.mock.calls[1][0]).toContain(`from=${shifted.from}&to=${shifted.to}`);
    await act(async () =>
      finish(
        failure === 'http'
          ? new Response(null, { status: 503 })
          : Response.json(
              response({
                from: shifted.from,
                to: shifted.to,
                bots: { status: 'unknown', reason: failure },
              }),
            ),
      ),
    );
    expect(screen.getByText('Refresh failed. Showing previous reading.')).toBeVisible();
    expect(screen.getByText('7')).toBeVisible();
    fetcher.mockResolvedValueOnce(
      Response.json(
        response({
          from: shifted.from,
          to: shifted.to,
          bots: { ...response().bots, pageview_attempts: 9, cloudflare_verified: 6 },
        }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry traffic quality' }));
    await screen.findByText('9');
    expect(screen.queryByText(/Showing previous reading/)).toBeNull();
    expect(screen.queryByText(/Previous bot window:/)).toBeNull();
  },
);

it.each([
  { period: 'range:7d' },
  { period: 'date:2026-11-02' },
  { ownerToken: 'other-owner' },
  { appId: 'other-app' },
  { environmentId: 'other-env' },
  { filtered: true },
])('clears an existing reading when its selected context changes %s', async (patch) => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(response()))
    .mockImplementation(() => new Promise(() => {}));
  const view = render(<TrafficQuality {...props} />);
  await screen.findByText('7');
  view.rerender(<TrafficQuality {...props} {...patch} report={{ ...report }} />);
  expect(screen.queryByText('7')).toBeNull();
  expect(screen.queryByText(/Showing previous reading/)).toBeNull();
});

it('clears an existing reading across workspace changes and backward window shifts', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(response()))
    .mockImplementation(() => new Promise(() => {}));
  const view = render(<TrafficQuality {...props} />);
  await screen.findByText('7');
  view.rerender(
    <TrafficQuality
      {...props}
      report={{ ...report, from: report.from - 60_000, to: report.to - 60_000 }}
    />,
  );
  expect(screen.queryByText('7')).toBeNull();
  act(() => selectWorkspace('other-workspace'));
  expect(screen.queryByText('7')).toBeNull();
  expect(screen.queryByText('12')).toBeNull();
});

it('treats an unsupported period response as terminal without a futile retry', async () => {
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status: 400 }));
  const view = render(<TrafficQuality {...props} period="date:2026-01-01" />);
  await screen.findByText('Bot counters are not available for this period.');
  expect(screen.queryByRole('button', { name: 'Retry traffic quality' })).toBeNull();
  expect(screen.queryByText('Bot counters could not load.')).toBeNull();
  view.rerender(<TrafficQuality {...props} period="date:2026-01-01" report={{ ...report }} />);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('clears a previous reading when the refreshed period is unsupported', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json(response()))
    .mockResolvedValueOnce(new Response(null, { status: 400 }));
  const view = render(<TrafficQuality {...props} />);
  await screen.findByText('7');
  view.rerender(
    <TrafficQuality
      {...props}
      report={{ ...report, from: report.from + 60_000, to: report.to + 60_000 }}
    />,
  );
  await screen.findByText('Bot counters are not available for this period.');
  expect(screen.queryByText('7')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry traffic quality' })).toBeNull();
});
