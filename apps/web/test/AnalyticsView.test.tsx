import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsView } from '../src/AnalyticsView.js';
const project = {
  appId: 'one',
  environmentId: 'prod',
  name: 'My project',
  environment: 'production',
};
const live = {
  measured_at: Date.now(),
  ttl_ms: 45000,
  total: 2,
  projects: [{ app_id: 'one', environment_id: 'prod', active: 2 }],
};
const summary = {
  enabled: true,
  source: 'local',
  sampled: false,
  stream: false,
  projects: [{ app_id: 'one', environment_id: 'prod', pageviews: 12, events: 3, sessions: 2 }],
  live,
};
const report = {
  from: 100,
  to: 1000,
  source: 'local',
  sampled: false,
  series: [{ timestamp: 500, pageviews: 12, events: 3 }],
  pages: [{ name: '/pricing', count: 12 }],
  sources: [{ name: 'google.com', count: 12 }],
  events: [{ name: 'signup.completed', count: 3, last_seen: 500 }],
  sessions: 2,
};
function install() {
  const mock = vi.fn(async (url: string) =>
    Response.json(url.startsWith('/v1/analytics/report') ? report : summary),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('shows focused project traffic, sources and events without a duplicate project roster', async () => {
  const fetch = install();
  const select = vi.fn();
  const setup = vi.fn();
  render(
    <AnalyticsView
      project={project}
      projects={[project]}
      ownerToken="owner"
      onSelect={select}
      onInstall={setup}
    />,
  );
  expect(await screen.findByText('/pricing')).toBeTruthy();
  expect(screen.getByText('google.com')).toBeTruthy();
  expect(screen.getByText('signup.completed')).toBeTruthy();
  expect(screen.getByText('Sessions')).toBeTruthy();
  expect(screen.queryByText('Your projects')).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Analytics project' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Install tracker/ }));
  expect(setup).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: /Product events/ }));
  expect(await screen.findByRole('heading', { name: 'Product events over time' })).toBeTruthy();
});
it('queries an event drill-down, project and time filters, and clears the selected event', async () => {
  const mock = install();
  render(
    <AnalyticsView
      project={project}
      projects={[project]}
      ownerToken=""
      onSelect={() => {}}
      mode="events"
    />,
  );
  expect(await screen.findByText('Event types')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Product events over time' })).toBeTruthy();
  expect(screen.queryByText('Page views')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Top pages' })).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Audience' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Explore signup.completed' }));
  await waitFor(() =>
    expect(mock.mock.calls.some(([url]) => url.includes('event=signup.completed'))).toBe(true),
  );
  expect(await screen.findByRole('heading', { name: 'Where this event happens' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Event referral sources' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Audience' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Analytics period' }), {
    key: 'ArrowDown',
  });
  fireEvent.click(await screen.findByRole('option', { name: 'Last hour' }));
  await waitFor(() =>
    expect(
      mock.mock.calls.some(([url]) =>
        url.includes('range=1h&app_id=one&environment_id=prod&event=signup.completed'),
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: /Clear event filter/ }));
  await waitFor(() =>
    expect(mock.mock.calls.at(-1)?.[0]).toBe(
      '/v1/analytics/report?range=1h&app_id=one&environment_id=prod',
    ),
  );
});
it('recovers from unavailable reports and explains empty events', async () => {
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/report')
        ? fail
          ? new Response(null, { status: 503 })
          : Response.json({ ...report, pages: [], sources: [], events: [], series: [] })
        : Response.json(summary),
    ),
  );
  render(
    <AnalyticsView project={project} projects={[project]} ownerToken="" onSelect={() => {}} />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Reports are unavailable');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText(/Your product has a story/)).toBeTruthy();
});
it('validates live frames and closes the workspace socket on unmount', async () => {
  class Socket {
    static latest: Socket;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    close = vi.fn();
    constructor(public url: URL) {
      Socket.latest = this;
    }
  }
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.includes('/report') ? report : { ...summary, source: 'analytics-engine', stream: true },
      ),
    ),
  );
  const view = render(
    <AnalyticsView project={project} projects={[project]} ownerToken="" onSelect={() => {}} />,
  );
  await waitFor(() => expect(Socket.latest).toBeTruthy());
  expect(Socket.latest.url.pathname).toBe('/v1/analytics/live');
  act(() => {
    Socket.latest.onopen?.();
    Socket.latest.onmessage?.({
      data: JSON.stringify({ ...live, projects: [{ ...live.projects[0], active: 7 }], total: 7 }),
    });
  });
  expect(screen.getByText('7')).toBeTruthy();
  act(() => Socket.latest.onmessage?.({ data: JSON.stringify({ total: -99 }) }));
  expect(screen.queryByText('-99')).toBeNull();
  act(() => Socket.latest.onmessage?.({ data: '{' }));
  act(() => Socket.latest.onclose?.());
  expect(screen.queryByText('7')).toBeNull();
  view.unmount();
  expect(Socket.latest.close).toHaveBeenCalledOnce();
});

it('stacks clicked page and source filters, preserves them across periods, and clears them independently', async () => {
  const mock = install();
  render(
    <AnalyticsView project={project} projects={[project]} ownerToken="" onSelect={() => {}} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Filter Top pages by /pricing' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toContain('path=%2Fpricing'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Filter Referral sources by google.com' }),
  );
  await waitFor(() => {
    const url = new URL(mock.mock.calls.at(-1)![0], 'https://local.test');
    expect(url.searchParams.get('path')).toBe('/pricing');
    expect(url.searchParams.get('source')).toBe('google.com');
  });
  expect(screen.getByText('All project sessions · not filtered')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Analytics period' }), {
    key: 'ArrowDown',
  });
  fireEvent.click(await screen.findByRole('option', { name: 'Last 7 days' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toContain('range=7d'));
  expect(mock.mock.calls.at(-1)?.[0]).toContain('path=%2Fpricing');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Page: /pricing filter' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).not.toContain('path='));
  expect(mock.mock.calls.at(-1)?.[0]).toContain('source=google.com');
  fireEvent.click(await screen.findByRole('button', { name: 'Explore signup.completed' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).toContain('event=signup.completed'));
  fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
  await waitFor(() => expect(mock.mock.calls.at(-1)?.[0]).not.toContain('source='));
  expect(screen.queryByRole('button', { name: /Remove Source/ })).toBeNull();
  expect(mock.mock.calls.at(-1)?.[0]).not.toContain('event=');
});

it('uses the matching prior-period counts in the main KPI cards', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.includes('/report')
          ? {
              ...report,
              previous: { pageviews: 6, events: 6, sessions: 2, visitors: 0 },
            }
          : summary,
      ),
    ),
  );
  render(
    <AnalyticsView project={project} projects={[project]} ownerToken="" onSelect={() => {}} />,
  );
  expect(await screen.findByLabelText('Page views comparison')).toHaveTextContent(
    '+100% vs previous period',
  );
  expect(screen.getByLabelText('Product events comparison')).toHaveTextContent(
    '-50% vs previous period',
  );
  expect(screen.getByLabelText('Sessions comparison')).toHaveTextContent(
    'No change vs previous period',
  );
  expect(screen.queryByLabelText('Active now comparison')).toBeNull();
});
