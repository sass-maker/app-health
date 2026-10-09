import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpeedReportV1 } from '@app-health/contracts';
import { SpeedView } from '../src/SpeedView.js';
import { speedFixture } from './speed-fixture.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount(report = speedFixture()) {
  const fetch = vi.fn(async () => Response.json(report));
  vi.stubGlobal('fetch', fetch);
  const view = render(<SpeedView ownerToken="owner" />);
  const table = await screen.findByRole('table', { name: 'Product speed' });
  return { fetch, table, ...view };
}

function productRow(table: HTMLElement, name: string) {
  return within(table)
    .getByRole('button', { name: `Show routes for ${name}` })
    .closest('tr')!;
}

async function select(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

it('renders authoritative states, CLS units, missing readings and truthful bounds', async () => {
  expect(SpeedReportV1.safeParse(speedFixture()).success).toBe(true);
  const { table, fetch } = await mount();
  const call = (fetch.mock.calls as unknown as [URL, RequestInit][])[0];
  expect(String(call[0])).toContain('/v1/reports/speed?range=24h&class=app');
  expect(new Headers(call[1].headers).get('authorization')).toBe('Bearer owner');
  expect(within(productRow(table, 'Atlas')).getByText('Breaching')).toBeInTheDocument();
  expect(within(productRow(table, 'Beacon')).getByText('Measured')).toBeInTheDocument();
  const cedar = productRow(table, 'Cedar');
  expect(within(cedar).getByText('Insufficient samples')).toBeInTheDocument();
  expect(within(cedar).queryByText('Breaching')).toBeNull();
  expect(within(cedar).getByText('4,000 ms')).not.toHaveClass('text-warning');
  const drift = productRow(table, 'Drift');
  expect(within(drift).getByText('No data')).toBeInTheDocument();
  expect(within(drift).getAllByLabelText('No samples')).toHaveLength(8);
  expect(within(drift).queryByText(/^0/)).toBeNull();
  expect(within(productRow(table, 'Atlas')).getByText('0.075')).toBeInTheDocument();
  expect(within(productRow(table, 'Atlas')).getByText('60%')).toBeInTheDocument();
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent('Truncated: yes');
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent('Rejected events: 3');
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent(
    '50 samples per web metric',
  );
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent(
    'Budgets (app): LCP p75 2,500 ms',
  );
});

it('filters state and product search without refetching', async () => {
  const { table, fetch } = await mount();
  await select('Speed state', 'Breaching');
  expect(within(table).getAllByRole('button', { name: /Show routes/ })).toHaveLength(1);
  expect(within(table).getByText('Atlas')).toBeInTheDocument();
  await select('Speed state', 'Insufficient');
  expect(within(table).getByText('Cedar')).toBeInTheDocument();
  await select('Speed state', 'No data');
  expect(within(table).getByText('Drift')).toBeInTheDocument();
  await select('Speed state', 'All');
  fireEvent.change(screen.getByRole('textbox', { name: 'Search products' }), {
    target: { value: ' bEaCoN ' },
  });
  expect(within(table).getAllByRole('button', { name: /Show routes/ })).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Search products' }), {
    target: { value: 'missing' },
  });
  expect(screen.getByText(/No products match these filters/)).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('sorts headers with aria-sort, keeping unknowns last in either direction', async () => {
  const { table } = await mount();
  const sort = within(table).getByRole('button', { name: 'Sort by LCP p75' });
  const names = () =>
    within(table)
      .getAllByRole('button', { name: /Show routes/ })
      .map((button) => button.textContent);
  fireEvent.click(sort);
  expect(sort.closest('th')).toHaveAttribute('aria-sort', 'ascending');
  expect(names()).toEqual(['Beacon', 'Atlas', 'Cedar', 'Drift']);
  fireEvent.click(sort);
  expect(sort.closest('th')).toHaveAttribute('aria-sort', 'descending');
  expect(names()).toEqual(['Cedar', 'Atlas', 'Beacon', 'Drift']);
  expect(
    within(table).getByRole('button', { name: 'Sort by Product' }).closest('th'),
  ).toHaveAttribute('aria-sort', 'none');
});

it('expands route metrics, cache counts, colos, stages and sustained flags', async () => {
  const { table } = await mount();
  const button = within(table).getByRole('button', { name: 'Show routes for Atlas' });
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  const web = screen.getByRole('table', { name: 'Atlas vitals routes' });
  expect(within(web).getByText('/articles')).toBeInTheDocument();
  expect(within(web).getByText(/lcp_ms: 2,800 ms > 2,500 ms/)).toBeInTheDocument();
  const server = screen.getByRole('table', { name: 'Atlas server routes' });
  for (const text of [
    '/api/articles/:id',
    '100 ms',
    '700 ms',
    '900 ms',
    'HIT: 18',
    'NONE: 10',
    'db_ms: 90 ms',
    'BOM: 650 ms · 30 samples',
    'Insufficient windows',
  ])
    expect(within(server).getByText(text)).toBeInTheDocument();
  expect(screen.getByText('Vitals truncated')).toBeInTheDocument();
  fireEvent.click(button);
  expect(screen.queryByRole('table', { name: 'Atlas server routes' })).toBeNull();
});

it.each([400, 403, 503])('shows a distinct %s error and retries', async (status) => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status }))
    .mockResolvedValue(Response.json(speedFixture()));
  vi.stubGlobal('fetch', fetch);
  render(<SpeedView ownerToken="owner" />);
  expect(await screen.findByRole('alert')).toHaveTextContent(String(status));
  fireEvent.click(screen.getByRole('button', { name: 'Retry speed report' }));
  expect(await screen.findByRole('table', { name: 'Product speed' })).toBeInTheDocument();
});

it.each([{}, { ...speedFixture(), class: 'landing' }])(
  'rejects invalid or mismatched responses',
  async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    );
    render(<SpeedView ownerToken="owner" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid speed report response');
  },
);

it('shows loading and an actionable empty state', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    ),
  );
  render(<SpeedView ownerToken="owner" />);
  expect(screen.getByRole('status', { name: 'Loading speed report' })).toBeInTheDocument();
  const report = speedFixture();
  report.products = [];
  report.summary = { measured: 0, no_data: 0, insufficient: 0, breaching: 0 };
  await act(async () => resolve(Response.json(report)));
  expect(await screen.findByText('No speed samples yet')).toBeInTheDocument();
  expect(screen.getByText('data-vitals')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'docs/performance-contract.md' })).toHaveAttribute(
    'href',
    expect.stringContaining('docs/performance-contract.md'),
  );
});

it('keeps no-data products visible alongside setup instructions and truncation flags', async () => {
  const report = speedFixture();
  report.products = [report.products[3]];
  report.summary = { measured: 0, no_data: 1, insufficient: 0, breaching: 0 };
  const { table } = await mount(report);
  expect(screen.getByText('No speed samples yet')).toBeInTheDocument();
  expect(within(table).getByText('Drift')).toBeInTheDocument();
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent('Truncated: yes');
});

it('uses sample-weighted error rates and cache counts, preserving an unknown all-NONE ratio', async () => {
  const report = speedFixture();
  const product = report.products[0];
  const other = structuredClone(product.server.routes[0]);
  other.route = '/api/search';
  other.samples = 10;
  other.error_rate = 0.5;
  other.cache = {
    HIT: 0,
    MISS: 0,
    EXPIRED: 0,
    BYPASS: 0,
    DYNAMIC: 0,
    STALE: 0,
    REVALIDATED: 0,
    NONE: 10,
    hit_ratio: null,
  };
  product.server.routes.push(other);
  product.server.samples = 50;
  const beacon = report.products[1];
  beacon.server.routes[0].cache = { ...other.cache, NONE: 40 };
  const { table } = await mount(report);
  expect(within(productRow(table, 'Atlas')).getByText('12%')).toBeInTheDocument();
  expect(within(productRow(table, 'Atlas')).getByText('60%')).toBeInTheDocument();
  expect(within(productRow(table, 'Beacon')).getAllByLabelText('No samples')).toHaveLength(2);
});

it('counts a sustained-only breach and preserves valid zero CLS readings', async () => {
  const report = speedFixture();
  const atlas = report.products[0];
  atlas.vitals.routes[0].breaches = [];
  atlas.server.routes[0].breaches = [];
  atlas.vitals.routes[0].cls_milli = { p75: 0 };
  const { table } = await mount(report);
  expect(within(productRow(table, 'Atlas')).getByText('Breaching')).toBeInTheDocument();
  expect(within(productRow(table, 'Atlas')).getByText('0')).toBeInTheDocument();
  await select('Speed state', 'Breaching');
  expect(within(table).getAllByRole('button', { name: /Show routes/ })).toHaveLength(1);
});

it('aborts old filter requests so late responses cannot replace the selected range', async () => {
  let resolveOld!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(Response.json({ ...speedFixture(), range: '1h' }));
  vi.stubGlobal('fetch', fetch);
  render(<SpeedView ownerToken="owner" />);
  await select('Speed range', '1 hour');
  await screen.findByRole('table', { name: 'Product speed' });
  const oldSignal = (fetch.mock.calls[0][1] as RequestInit).signal;
  expect(oldSignal?.aborted).toBe(true);
  const old = speedFixture();
  old.products[0].name = 'Retired reading';
  await act(async () => resolveOld(Response.json(old)));
  expect(screen.queryByText('Retired reading')).toBeNull();
  expect(screen.getByRole('button', { name: 'Show routes for Atlas' })).toBeInTheDocument();
});

it('polls at 60 seconds only while visible, and stops on unmount', async () => {
  vi.useFakeTimers();
  let visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  const fetch = vi.fn(async () => Response.json(speedFixture()));
  vi.stubGlobal('fetch', fetch);
  const { unmount } = render(<SpeedView ownerToken="owner" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'hidden';
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  visibility = 'visible';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('refetches range and class and uses the returned budgets', async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const params = new URL(String(input)).searchParams;
    const report = speedFixture();
    report.range = params.get('range') as typeof report.range;
    report.class = params.get('class') as typeof report.class;
    if (report.class === 'api') report.budgets.vitals = null;
    return Response.json(report);
  });
  vi.stubGlobal('fetch', fetch);
  render(<SpeedView ownerToken="" />);
  await screen.findByRole('table', { name: 'Product speed' });
  await select('Speed range', '7 days');
  await screen.findByRole('table', { name: 'Product speed' });
  await select('Performance class', 'API');
  await screen.findByRole('table', { name: 'Product speed' });
  expect(String(fetch.mock.calls.at(-1)![0])).toContain('range=7d&class=api');
  expect(screen.getByText(/Samples, not total traffic/)).toHaveTextContent(
    'Budgets (api): no Web Vitals budget',
  );
});
