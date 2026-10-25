import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

type Project = { appId: string; environmentId: string; name: string; environment: string };

// Keep the real application selection, URL navigation, analytics view and requests.
// The briefing's callback arguments are separately covered by DailyEngagement.test.
vi.mock('../src/ProjectsView.js', () => ({
  ProjectsView: ({
    projects,
    onOpen,
  }: {
    projects: Project[];
    onOpen: (project: Project, focus: string, source: string, date: string) => void;
  }) => (
    <div>
      {projects.flatMap((project) =>
        ['No referrer', 'google.com'].map((source) => (
          <button
            key={`${project.appId}/${source}`}
            onClick={() => onOpen(project, 'analytics', source, '2026-10-22')}
          >
            open {project.name} {source}
          </button>
        )),
      )}
    </div>
  ),
}));

const projects: Project[] = ['alpha', 'beta'].map((name) => ({
  appId: `app-${name}`,
  environmentId: `env-${name}`,
  name,
  environment: 'production',
}));

function install() {
  const stored = new Map([['app-health-v0-project', JSON.stringify(projects[0])]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  history.replaceState(null, '', '/app?project=app-alpha&environment=env-alpha#overview');
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === '/v1/account/config') return Response.json({ google: false });
    if (url.pathname === '/v1/apps')
      return Response.json(
        {
          apps: projects.map((project) => ({
            app: { id: project.appId, name: project.name, created_at: 1 },
            environments: [
              {
                id: project.environmentId,
                app_id: project.appId,
                name: project.environment,
                created_at: 1,
              },
            ],
          })),
        },
        { headers: { 'x-app-health-workspace-role': 'owner' } },
      );
    if (url.pathname === '/v1/capabilities')
      return Response.json({
        app_id: url.searchParams.get('app_id'),
        environment_id: url.searchParams.get('environment_id'),
        capabilities: ['analytics', 'endpoints', 'logs'].map((id) => ({
          id,
          enabled: true,
          first_received_at: 1,
          last_received_at: 1,
        })),
        private_key: null,
      });
    if (url.pathname === '/v1/installation/status')
      return Response.json({
        state: 'connected',
        runtime: 'node',
        first_seen: 1,
        last_seen: 1,
        next_action: 'Connected',
      });
    if (url.pathname === '/v1/analytics')
      return Response.json({
        enabled: true,
        source: 'local',
        sampled: false,
        stream: false,
        projects: [],
        live: { measured_at: 1, ttl_ms: 45000, total: 0, projects: [] },
      });
    if (url.pathname === '/v1/analytics/report')
      return Response.json({
        from: 1,
        to: 2,
        source: 'local',
        sampled: false,
        series: [],
        pages: [],
        sources: [],
        events: [],
        sessions: 0,
      });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/app');
});

it.each([
  ['alpha', 'No referrer', 'Unknown'],
  ['beta', 'No referrer', 'Unknown'],
  ['beta', 'google.com', 'google.com'],
])('opens %s with the completed day and %s source intact', async (name, source, expectedSource) => {
  const fetch = install();
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: `open ${name} ${source}` }));
  await waitFor(() => {
    const params = new URLSearchParams(location.search);
    expect(params.get('project')).toBe(`app-${name}`);
    expect(params.get('environment')).toBe(`env-${name}`);
    expect(params.get('briefing_date')).toBe('2026-10-22');
    expect(params.get('briefing_source')).toBe(expectedSource);
  });
  expect(await screen.findByRole('combobox', { name: 'Analytics period' })).toHaveTextContent(
    '2026-10-22 · India day',
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([input]) => {
        const url = new URL(String(input), location.origin);
        return (
          url.pathname === '/v1/analytics/report' &&
          url.searchParams.get('app_id') === `app-${name}` &&
          url.searchParams.get('environment_id') === `env-${name}` &&
          url.searchParams.get('date') === '2026-10-22' &&
          url.searchParams.get('source') === expectedSource &&
          url.searchParams.get('breakdown') === 'acquisition'
        );
      }),
    ).toBe(true),
  );
});
