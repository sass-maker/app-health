import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { RevenueReportV1, RevenueTotalV1 } from '@app-health/contracts';
import { Revenue } from '../src/Revenue.js';
import { averagePayment, formatPaymentMinor } from '../src/lib/payment-format.js';

const query = { app_id: 'app-one', environment_id: 'production', range: '24h' as const };
function total(patch: Partial<RevenueTotalV1> = {}): RevenueTotalV1 {
  return {
    provider: 'custom',
    account_id: 'merchant',
    mode: 'live',
    currency: 'USD',
    gross_minor: 1000,
    refunds_minor: 250,
    net_minor: 750,
    payments: 2,
    refunds: 1,
    attributed_payments: 1,
    pending_refunds: 1,
    pending_refunds_minor: 100,
    ...patch,
  };
}
function report(rows = [total()]): RevenueReportV1 {
  return {
    schema_version: 1,
    from: 0,
    to: 100,
    source: 'd1',
    basis: 'recorded_cashflows',
    coverage_note: 'Accepted financial facts only; provider completeness is unverified.',
    breakdown: 'source',
    totals: rows,
    dimensions: rows.map((row) => ({ ...row, value: null })),
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('formats currency minor units exactly, including zero/three decimals and large safe integers', () => {
  expect(formatPaymentMinor(123, 'USD')).toBe('$1.23');
  expect(formatPaymentMinor(-99, 'USD')).toBe('-$0.99');
  expect(formatPaymentMinor(1000, 'JPY')).toBe('¥1,000');
  expect(formatPaymentMinor(1234, 'BHD').replace(/\s/g, ' ')).toBe('BHD 1.234');
  expect(formatPaymentMinor(Number.MAX_SAFE_INTEGER, 'USD')).toBe('$90,071,992,547,409.91');
  expect(formatPaymentMinor(-Number.MAX_SAFE_INTEGER, 'USD')).toBe('-$90,071,992,547,409.91');
  expect(formatPaymentMinor(123, 'ZZZ')).toBe('123 minor ZZZ');
  expect(formatPaymentMinor(1.2, 'USD')).toBe('—');
  expect(averagePayment(101, 2, 'USD')).toBe('$0.51');
  expect(averagePayment(100, 3, 'USD')).toBe('$0.33');
  expect(averagePayment(1, 2, 'JPY')).toBe('¥1');
  expect(averagePayment(0, 0, 'USD')).toBe('—');
});

it('loads financial facts on demand and keeps currencies, refunds and explicit attribution coverage separate', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(report([total(), total({ currency: 'JPY', net_minor: 1000 })])),
  );
  vi.stubGlobal('fetch', fetch);
  render(<Revenue query={query} ownerToken="owner" />);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'explore revenue' }));
  expect(await screen.findByText('$7.50', { selector: 'p' })).toBeVisible();
  expect(screen.getByText('¥1,000', { selector: 'p' })).toBeVisible();
  expect(screen.getAllByText('$5.00')).toHaveLength(1);
  expect(
    screen.getByText(/1 refunds await their original payment: \$1.00 excluded from net/),
  ).toBeVisible();
  expect(
    screen.getAllByText(/1 of 2 payments carry an explicit source, page, country or campaign/),
  ).toHaveLength(2);
  expect(screen.getByRole('table', { name: 'Revenue by source' })).toBeVisible();
  expect(
    screen.getByText(/Traffic and event filters do not filter these financial facts/),
  ).toBeVisible();
  const url = new URL(String(fetch.mock.calls[0][0]));
  expect(url.searchParams.get('mode')).toBe('live');
  expect(Number(url.searchParams.get('to')) - Number(url.searchParams.get('from'))).toBe(86400000);
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Payment mode' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'test payments' }));
  await waitFor(() =>
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get('mode')).toBe('test'),
  );
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Revenue breakdown' }), {
    key: 'ArrowDown',
  });
  fireEvent.click(await screen.findByRole('option', { name: 'campaign' }));
  await waitFor(() =>
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get('breakdown')).toBe(
      'campaign',
    ),
  );
});

it('offers retry for unavailable or malformed financial data and describes empty history without a completeness claim', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(Response.json({}))
    .mockResolvedValue(Response.json(report([])));
  vi.stubGlobal('fetch', fetch);
  render(<Revenue query={query} ownerToken="owner" />);
  fireEvent.click(screen.getByRole('button', { name: 'explore revenue' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Recorded revenue could not load');
  fireEvent.click(screen.getByRole('button', { name: 'refresh revenue' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(screen.getByRole('alert')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'refresh revenue' }));
  expect(await screen.findByText(/No recorded payments in this period and mode/)).toBeVisible();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'hide revenue' }));
  expect(screen.queryByText(/No recorded payments/)).toBeNull();
});

it('discards late financial replies after project, owner, period and visibility changes', async () => {
  let resolve!: (value: Response) => void;
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(Response.json(report([total({ currency: 'JPY' })])));
  vi.stubGlobal('fetch', fetch);
  const view = render(<Revenue query={query} ownerToken="owner" />);
  fireEvent.click(screen.getByRole('button', { name: 'explore revenue' }));
  view.rerender(
    <Revenue query={{ ...query, app_id: 'other', range: '1h' }} ownerToken="other-owner" />,
  );
  await screen.findByText('¥750', { selector: 'p' });
  await act(async () => resolve(Response.json(report())));
  expect(screen.queryByText('$7.50', { selector: 'p' })).toBeNull();
  const latest = new URL(String(fetch.mock.calls.at(-1)![0]));
  expect(latest.searchParams.get('app_id')).toBe('other');
  expect(Number(latest.searchParams.get('to')) - Number(latest.searchParams.get('from'))).toBe(
    3600000,
  );
});

it('switches to provider creation-date reports without mixing custom cashflow totals or hiding unresolved resources', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const provider = String(input).includes('provider-revenue');
      return Response.json(
        provider
          ? {
              ...report([total({ provider: 'polar', gross_minor: 1200, net_minor: 1000 })]),
              basis: 'provider_object_created',
              coverage_note:
                'Gross paid order values including tax by resource creation date; multicapture timing unsupported.',
              unresolved: [{ reason: 'mixed_destination_cart_no_allocation', count: 2 }],
              diagnostics_truncated: true,
            }
          : report(),
      );
    }),
  );
  render(<Revenue query={query} ownerToken="owner" />);
  fireEvent.click(screen.getByRole('button', { name: 'explore revenue' }));
  await screen.findByText('$7.50', { selector: 'p' });
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Revenue basis' }), { key: 'ArrowDown' });
  fireEvent.click(
    await screen.findByRole('option', { name: 'providers · resource creation dates' }),
  );
  expect(await screen.findByText('$10.00', { selector: 'p' })).toBeVisible();
  expect(screen.queryByText('$7.50', { selector: 'p' })).toBeNull();
  expect(screen.getByText('net paid order/payment value')).toBeVisible();
  expect(screen.getByText('2 · mixed destination cart no allocation')).toBeVisible();
  expect(screen.getByText(/Provider diagnostics are bounded and incomplete/)).toBeVisible();
});
