import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsView } from '../src/ProjectsView.js';

const now = 1_800_000_000_000;
const projects = [
  { appId: 'one', environmentId: 'prod', name: 'Atlas', environment: 'production' },
  { appId: 'one', environmentId: 'staging', name: 'Atlas', environment: 'staging' },
  { appId: 'two', environmentId: 'prod', name: 'Beacon', environment: 'production' },
];

const summary = {
  enabled: true,
  source: 'local',
  sampled: false,
  stream: false,
  projects: [
    { app_id: 'one', environment_id: 'prod', pageviews: 120, events: 14, sessions: 8 },
    { app_id: 'one', environment_id: 'staging', pageviews: 4, events: 1, sessions: 2 },
  ],
  live: { measured_at: now, ttl_ms: 45000, total: 0, projects: [] },
};

const health = {
  refreshed_at: now,
  window_end: now,
  window: '24h',
  environments: [
    {
      app_id: 'one',
      app_name: 'Atlas',
      environment_id: 'prod',
      environment_name: 'production',
      analytics: { enabled: true, first_received_at: now - 10_000, last_received_at: now - 5_000 },
      endpoints: {
        state: 'connected',
        runtime: 'worker',
        first_received_at: now - 100_000,
        last_received_at: now - 60_000,
        metrics: {
          request_count: 100,
          error_count: 6,
          error_rate: 0.06,
          p95_ms: 2500,
          last_seen: now - 60_000,
          health_state: 'unhealthy',
        },
      },
    },
    {
      app_id: 'one',
      app_name: 'Atlas',
      environment_id: 'staging',
      environment_name: 'staging',
      analytics: { enabled: true, first_received_at: now - 10_000, last_received_at: now - 5_000 },
      endpoints: {
        state: 'unconfigured',
        runtime: null,
        first_received_at: null,
        last_received_at: null,
        metrics: null,
      },
    },
    {
      app_id: 'two',
      app_name: 'Beacon',
      environment_id: 'prod',
      environment_name: 'production',
      analytics: { enabled: false, first_received_at: null, last_received_at: null },
      endpoints: {
        state: 'connected',
        runtime: 'go',
        first_received_at: now - 100_000,
        last_received_at: now - 60_000,
        metrics: {
          request_count: 50,
          error_count: 0,
          error_rate: 0,
          p95_ms: 100,
          last_seen: now - 60_000,
          health_state: 'healthy',
        },
      },
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

function installFetch(options?: { healthResponse?: Response }) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/v1/workspace/health'))
      return options?.healthResponse ?? Response.json(health);
    return Response.json(summary);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('puts exceptions first while retaining every environment in the inventory', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="owner" onOpen={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'What needs attention now?' })).toBeTruthy();
  const queue = screen.getByText('Attention queue').closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(queue).getByText(/Unhealthy requests/)).toBeTruthy();
  expect(within(queue).getByText(/Endpoint monitoring not configured/)).toBeTruthy();
  expect(within(queue).queryByText('Beacon')).toBeNull();
  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(inventory).getAllByText('Atlas')).toHaveLength(2);
  expect(within(inventory).getByText('Beacon')).toBeTruthy();
  expect(within(inventory).getByText('120')).toBeTruthy();
  expect(within(inventory).getByText('100 requests')).toBeTruthy();
  expect(screen.getByText(/Requests are server or function calls/)).toBeTruthy();
});

it('shows exact freshness and never turns missing measurements into zero', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="" onOpen={() => {}} />);
  await screen.findByText('Complete inventory');
  expect(screen.getAllByText('Never received').length).toBeGreaterThan(0);
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  expect(
    document.querySelector(`time[dateTime="${new Date(now - 60_000).toISOString()}"]`),
  ).toBeTruthy();
});

it('searches and filters the complete inventory', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="" onOpen={() => {}} />);
  const search = await screen.findByRole('textbox', { name: 'Search inventory' });
  fireEvent.change(search, { target: { value: 'Beacon' } });
  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(inventory).getByText('Beacon')).toBeTruthy();
  expect(within(inventory).queryByText('Atlas')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Attention only' }));
  expect(within(inventory).getByText('No environments match this view.')).toBeTruthy();
});

it('opens the selected environment from the inventory', async () => {
  installFetch();
  const onOpen = vi.fn();
  render(<ProjectsView projects={[projects[2]]} ownerToken="" onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole('button', { name: /Open/ }));
  expect(onOpen).toHaveBeenCalledWith(projects[2]);
});

it('keeps partial data visible and retries both workspace feeds', async () => {
  const fetch = installFetch({ healthResponse: new Response(null, { status: 503 }) });
  render(<ProjectsView projects={[projects[0]]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Some Watchtower data could not refresh',
  );
  expect(screen.getByText('120')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(4));
});

it('explains the empty workspace state', async () => {
  installFetch();
  render(<ProjectsView projects={[]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
});
