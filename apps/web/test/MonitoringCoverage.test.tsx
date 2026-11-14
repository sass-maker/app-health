import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MonitoringReport } from '@app-health/contracts';
import { MonitoringCoverage } from '../src/MonitoringCoverage.js';
import {
  selectWorkspace,
  updateWorkspaceRole,
  workspaceScope,
} from '../src/lib/workspace-scope.js';

const now = Date.now();
const report: MonitoringReport = {
  schema_version: 1,
  generated_at: now,
  policy_updated_at: now,
  projects: Array.from({ length: 40 }, (_, i) => ({
    catalog_id: `project-${i}`,
    name: `Project ${i}`,
    scope: 'public',
    reason: null,
    journeys: ['home'],
    app_id: `app-${i}`,
    environment_id: `env-${i}`,
    state: 'healthy',
    checks: [
      {
        journey: 'home',
        freshness: 'fresh',
        health: 'healthy',
        observations: [
          {
            location: 'cloudflare-hourly',
            last_seen_at: now - 1000,
            interval_seconds: 3600,
            freshness: 'fresh',
            health: 'healthy',
            failure: null,
            total_ms: 100,
          },
        ],
      },
    ],
  })),
};
report.projects[1] = {
  ...report.projects[1],
  state: 'missing',
  checks: [{ journey: 'home', freshness: 'missing', health: null, observations: [] }],
};
report.projects[2] = {
  ...report.projects[2],
  state: 'failing',
  checks: [
    {
      journey: 'home',
      freshness: 'fresh',
      health: 'failing',
      observations: [
        {
          location: 'cloudflare-hourly',
          last_seen_at: now,
          interval_seconds: 3600,
          freshness: 'fresh',
          health: 'failing',
          failure: 'timeout',
          total_ms: 8000,
        },
      ],
    },
  ],
};
report.projects[3] = {
  ...report.projects[3],
  scope: 'local',
  state: 'local',
  reason: 'Local service only.',
  journeys: [],
  checks: [],
};
report.projects[4] = {
  ...report.projects[4],
  scope: 'private',
  state: 'private',
  reason: 'Private workflow remains unobserved.',
  journeys: [],
  checks: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  selectWorkspace('');
});

it('renders all40 projects and distinguishes missing and private coverage from healthy checks', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(report)),
  );
  render(<MonitoringCoverage ownerToken="owner" />);
  expect(await screen.findByText('40 projects · 36 healthy · 1 failing or slow')).toBeTruthy();
  expect(screen.getByLabelText('Project monitoring coverage').children).toHaveLength(40);
  expect(screen.getByText('missing checks')).toBeTruthy();
  expect(screen.getByText('failing')).toBeTruthy();
  expect(screen.getByText('Private workflow remains unobserved.')).toBeTruthy();
  expect(screen.getByText('Local service only.')).toBeTruthy();
  expect(screen.getByText('No accepted check result.')).toBeTruthy();
  expect(screen.getByText(/No errors does not establish health/)).toBeTruthy();
});

it('hides the old workspace immediately and rejects a late response after switching', async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue(
        Response.json({
          schema_version: 1,
          generated_at: now,
          policy_updated_at: null,
          projects: [],
        }),
      ),
  );
  render(<MonitoringCoverage ownerToken="" />);
  act(() => selectWorkspace('other'));
  expect(
    await screen.findByText('Monitoring coverage is not configured for this workspace.'),
  ).toBeTruthy();
  await act(async () => {
    resolve(Response.json(report));
    await pending;
  });
  expect(screen.queryByText('Project 0')).toBeNull();
});

it('imports an explicit owner roster without treating the declaration as accepted health', async () => {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  const empty = { schema_version: 1, generated_at: now, policy_updated_at: null, projects: [] };
  const fetcher = vi.fn(async (_path: unknown, init?: RequestInit) =>
    init?.method === 'PUT' ? Response.json({ state: 'declared' }) : Response.json(empty),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<MonitoringCoverage ownerToken="" />);
  await screen.findByText('Monitoring coverage is not configured for this workspace.');
  const policy = {
    schema_version: 1,
    projects: report.projects.map(({ catalog_id, name, scope, reason, journeys }) => ({
      catalog_id,
      name,
      scope,
      reason,
      journeys,
    })),
  };
  const file = new File([JSON.stringify(policy)], 'coverage.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => JSON.stringify(policy) });
  fireEvent.change(screen.getByLabelText('Monitoring roster file'), { target: { files: [file] } });
  expect(await screen.findByText('Roster saved. Check results establish coverage.')).toBeTruthy();
  await waitFor(() =>
    expect(fetcher.mock.calls.some((call) => call[1]?.method === 'PUT')).toBe(true),
  );
  const put = fetcher.mock.calls.find((call) => call[1]?.method === 'PUT');
  expect(put?.[0]).toBe('/v1/workspace/monitoring/policy');
  expect(JSON.parse(String(put?.[1]?.body)).projects).toHaveLength(40);
  expect(screen.queryByText('Project 0')).toBeNull();
});

it('does not upload a pending file after its initiating workspace closes', async () => {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  const fetcher = vi.fn(async () =>
    Response.json({
      schema_version: 1,
      generated_at: now,
      policy_updated_at: null,
      projects: [],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(<MonitoringCoverage ownerToken="" />);
  await screen.findByText('Monitoring coverage is not configured for this workspace.');
  let finish!: (text: string) => void;
  const contents = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const file = new File(['{}'], 'coverage.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => contents });
  fireEvent.change(screen.getByLabelText('Monitoring roster file'), { target: { files: [file] } });
  view.unmount();
  await act(async () => {
    finish(
      JSON.stringify({
        schema_version: 1,
        projects: [
          {
            catalog_id: 'local',
            name: 'Local',
            scope: 'local',
            reason: 'Local only.',
            journeys: [],
          },
        ],
      }),
    );
    await contents;
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
