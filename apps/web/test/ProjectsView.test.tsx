import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsView } from '../src/ProjectsView.js';

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
    { app_id: 'one', environment_id: 'prod', pageviews: 120, events: 14 },
    { app_id: 'one', environment_id: 'staging', pageviews: 4, events: 1 },
  ],
  live: {
    measured_at: Date.now(),
    ttl_ms: 45000,
    total: 3,
    projects: [{ app_id: 'one', environment_id: 'prod', active: 3 }],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function installFetch(response: Response | object = summary) {
  const fetch = vi.fn(async () =>
    response instanceof Response ? response : Response.json(response),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('groups environments and shows historical plus live values', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="owner" onOpen={() => {}} />);
  expect((await screen.findAllByText('Atlas')).length).toBe(3);
  expect(screen.getByText('120')).toBeTruthy();
  expect(screen.getByText('14')).toBeTruthy();
  expect(screen.getByText('3')).toBeTruthy();
  expect(screen.getAllByText('production')).toHaveLength(2);
  expect(screen.getByText('staging')).toBeTruthy();
});

it('does not show a misleading live zero while the stream is disconnected', async () => {
  installFetch({ ...summary, source: 'analytics-engine', stream: false });
  render(<ProjectsView projects={[projects[0]]} ownerToken="owner" onOpen={() => {}} />);
  expect(await screen.findByText('120')).toBeTruthy();
  expect(screen.getByText('—')).toBeTruthy();
});

it('opens internal analytics on an unmodified click and preserves modified links', async () => {
  installFetch();
  const onOpen = vi.fn();
  render(<ProjectsView projects={[projects[0]]} ownerToken="" onOpen={onOpen} />);
  const link = await screen.findByRole('link', { name: /Open analytics/ });
  fireEvent.click(link);
  expect(onOpen).toHaveBeenCalledWith(projects[0]);
  fireEvent.click(link, { ctrlKey: true });
  expect(onOpen).toHaveBeenCalledOnce();
  expect(link).toHaveAttribute('target', '_blank');
});

it('reports copy success and exposes a selectable fallback on copy failure', async () => {
  installFetch();
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<ProjectsView projects={[projects[0]]} ownerToken="" onOpen={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy dashboard link' }));
  await waitFor(() => expect(screen.getByText('Dashboard link copied.')).toBeTruthy());
  vi.stubGlobal('navigator', {});
  fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
  expect(await screen.findByRole('textbox', { name: 'Dashboard link fallback' })).toHaveValue(
    'http://localhost:3000/app?project=one&environment=prod#analytics',
  );
});

it('shows an actionable error and retries the workspace request', async () => {
  let failed = true;
  const fetch = vi.fn(async () => {
    if (failed) return new Response(null, { status: 503 });
    return Response.json(summary);
  });
  vi.stubGlobal('fetch', fetch);
  render(<ProjectsView projects={[projects[0]]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Analytics could not refresh');
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
});

it('explains the empty workspace state', async () => {
  installFetch();
  render(<ProjectsView projects={[]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
});
