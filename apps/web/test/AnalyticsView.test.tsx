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
  projects: [{ app_id: 'one', environment_id: 'prod', pageviews: 12, events: 3 }],
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
it('shows traffic, top pages, sources, event names and a path to application health', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: /My project/ }));
  expect(select).toHaveBeenCalledWith(project);
  fireEvent.click(screen.getByRole('button', { name: /Install tracker/ }));
  expect(setup).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('tab', { name: /Product events/ }));
  expect(await screen.findByRole('heading', { name: 'Event activity' })).toBeTruthy();
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
  fireEvent.click(await screen.findByRole('button', { name: 'Explore signup.completed' }));
  await waitFor(() =>
    expect(mock.mock.calls.some(([url]) => url.includes('event=signup.completed'))).toBe(true),
  );
  expect(await screen.findByRole('heading', { name: 'Where this event happens' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Analytics project' }), {
    key: 'ArrowDown',
  });
  fireEvent.click(await screen.findByRole('option', { name: 'My project' }));
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
