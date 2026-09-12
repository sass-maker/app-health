import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PublicAnalyticsView } from '../src/PublicAnalyticsView.js';

const token = `ahs_${'a'.repeat(43)}`;
const payload = {
  project: { name: 'Storefront', environment: 'production' },
  live: { active: 4, measured_at: 1_700_000_000_000, ttl_ms: 45_000 },
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

function setLocation(value: { hash?: string; search?: string }) {
  window.history.replaceState({}, '', `/live${value.search ?? ''}${value.hash ?? ''}`);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocation({});
});

it('does not request or expose an invalid share token', () => {
  setLocation({ hash: '#token=ahs_short' });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
  expect(fetch).not.toHaveBeenCalled();
  expect(document.body).not.toHaveTextContent('ahs_short');
});

it('renders a redacted public analytics page and keeps the token out of the request URL and DOM', async () => {
  setLocation({ hash: `#token=${token}`, search: '?embed=1' });
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`);
    return Response.json(payload);
  });
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  expect((await screen.findAllByText('Storefront')).length).toBeGreaterThan(0);
  expect(screen.getByText('production')).toBeTruthy();
  expect(screen.getByText('28')).toBeTruthy();
  expect(document.body).not.toHaveTextContent(token);
  expect(String(fetch.mock.calls[0]?.[0])).not.toContain(token);
  expect(screen.queryByRole('link', { name: /about app health/i })).toBeNull();
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByRole('contentinfo')).toBeNull();
});

it('keeps the full public page linked and exposes page views without event columns', async () => {
  setLocation({ search: '', hash: `#token=${token}` });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(payload)),
  );
  render(<PublicAnalyticsView />);
  expect(await screen.findByRole('link', { name: /about app health/i })).toHaveAttribute(
    'href',
    '/',
  );
  fireEvent.click(screen.getByText('View chart values'));
  expect(screen.getByText('Page views')).toBeTruthy();
  expect(screen.queryByText('Events')).toBeNull();
});

it.each([
  ['project name', { project: { name: 42, environment: 'production' } }],
  ['live active count', { live: { ...payload.live, active: '4' } }],
  ['traffic pageviews', { traffic: { ...payload.traffic, pageviews: '28' } }],
  ['traffic from', { traffic: { ...payload.traffic, from: null } }],
  ['traffic to', { traffic: { ...payload.traffic, to: null } }],
  ['traffic series', { traffic: { ...payload.traffic, series: null } }],
  [
    'negative series value',
    { traffic: { ...payload.traffic, series: [{ timestamp: 1, pageviews: -1 }] } },
  ],
  ['source', { source: 'other' }],
  ['sample flag', { sampled: 'false' }],
  ['updated timestamp', { updated_at: null }],
])('rejects malformed %s responses as temporary unavailability', async (_, change) => {
  setLocation({ search: '', hash: `#token=${token}` });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ...payload, ...change })),
  );
  render(<PublicAnalyticsView />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
  expect(screen.queryByText('Storefront')).toBeNull();
});

it('renders sampled historical data and an unavailable traffic state honestly', async () => {
  setLocation({ search: '', hash: `#token=${token}` });
  const partial = { ...payload, traffic: null, source: 'analytics-engine' as const, sampled: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(partial)),
  );
  render(<PublicAnalyticsView />);
  expect(await screen.findByText('Storefront')).toBeTruthy();
  expect(screen.getByText('—')).toBeTruthy();
  expect(screen.getByText(/Traffic is (temporarily )?unavailable/)).toBeTruthy();
  expect(screen.getByText(/Event totals may arrive later/)).toBeTruthy();
  expect(screen.getByText(/Sampled estimates/)).toBeTruthy();
});

it('erases visible data when the share link is revoked', async () => {
  vi.useFakeTimers();
  setLocation({ hash: `#token=${token}` });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(payload))
    .mockResolvedValueOnce(new Response(null, { status: 410 }));
  vi.stubGlobal('fetch', fetch);
  render(<PublicAnalyticsView />);
  await act(async () => await Promise.resolve());
  expect(screen.getAllByText('Storefront').length).toBeGreaterThan(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
  expect(screen.queryByText('Storefront')).toBeNull();
  expect(screen.queryByText('28')).toBeNull();
});

it('pauses polling while hidden and requests immediately on resume', async () => {
  vi.useFakeTimers();
  setLocation({ hash: `#token=${token}` });
  const fetch = vi.fn().mockResolvedValue(Response.json(payload));
  vi.stubGlobal('fetch', fetch);
  let hidden = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
  render(<PublicAnalyticsView />);
  await act(async () => await Promise.resolve());
  hidden = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => await vi.advanceTimersByTimeAsync(20_000));
  expect(fetch).toHaveBeenCalledTimes(1);
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => await Promise.resolve());
  expect(fetch).toHaveBeenCalledTimes(2);
});
