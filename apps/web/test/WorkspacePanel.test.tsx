import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const { ownerFetch } = vi.hoisted(() => ({ ownerFetch: vi.fn() }));
vi.mock('../src/lib/owner-fetch.js', () => ({ ownerFetch }));
vi.mock('../src/lib/workspace-scope.js', () => ({
  selectWorkspace: vi.fn(),
  useWorkspaceScope: () => ({ id: '', role: 'owner', epoch: 0 }),
}));

import { WorkspacePanel } from '../src/WorkspacePanel.js';

const projects = [
  { appId: 'app-one', environmentId: 'prod-one', name: 'Northstar', environment: 'production' },
  { appId: 'app-two', environmentId: 'prod-two', name: 'Papertrail', environment: 'production' },
  { appId: 'app-two', environmentId: 'stage-two', name: 'Papertrail', environment: 'staging' },
];
const selected = { appId: 'app-one', environmentId: 'prod-one' };

function mockRequests() {
  ownerFetch.mockImplementation(async (_path: string, _token: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ token: 'new-api-token' }, { status: 201 });
    if (_path === '/v1/workspaces') return Response.json({ workspaces: [] });
    if (_path === '/v1/workspace/members') return Response.json({ members: [] });
    if (_path === '/v1/workspace/invites') return Response.json({ invites: [] });
    if (_path === '/v1/workspace/api-tokens') return Response.json({ tokens: [] });
    return Response.json({});
  });
}

async function openTokenForm() {
  fireEvent.click(screen.getByRole('button', { name: 'manage workspace access' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'API token name' }), {
    target: { value: 'Daily collector' },
  });
  await waitFor(() =>
    expect(
      ownerFetch.mock.calls.some(
        ([path, , init]) => path === '/v1/workspace/api-tokens' && init?.method !== 'POST',
      ),
    ).toBe(true),
  );
}

afterEach(() => {
  ownerFetch.mockReset();
  vi.restoreAllMocks();
});

it('defaults to the selected production scope and submits only explicitly selected scopes', async () => {
  mockRequests();
  render(<WorkspacePanel ownerToken="" project={selected} projects={projects} />);
  await openTokenForm();
  expect(screen.getByRole('checkbox', { name: /Northstar · production/ })).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: /staging/ })).toBeNull();

  fireEvent.click(screen.getByRole('checkbox', { name: /Papertrail · production/ }));
  fireEvent.click(screen.getByRole('button', { name: 'create API token' }));
  await waitFor(() =>
    expect(ownerFetch).toHaveBeenCalledWith(
      '/v1/workspace/api-tokens',
      '',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
  const create = ownerFetch.mock.calls.find(
    (call) => call[0] === '/v1/workspace/api-tokens' && call[2]?.method === 'POST',
  );
  expect(JSON.parse(String(create?.[2]?.body))).toEqual({
    name: 'Daily collector',
    permission: 'read',
    scopes: [
      { app_id: 'app-one', environment_id: 'prod-one' },
      { app_id: 'app-two', environment_id: 'prod-two' },
    ],
  });

  expect(screen.getByRole('checkbox', { name: /Northstar · production/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Papertrail · production/ })).not.toBeChecked();
  fireEvent.change(screen.getByRole('textbox', { name: 'API token name' }), {
    target: { value: 'Daily collector follow-up' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'create API token' }));
  await waitFor(() =>
    expect(
      ownerFetch.mock.calls.filter(
        ([path, , init]) => path === '/v1/workspace/api-tokens' && init?.method === 'POST',
      ),
    ).toHaveLength(2),
  );
  const creates = ownerFetch.mock.calls.filter(
    ([path, , init]) => path === '/v1/workspace/api-tokens' && init?.method === 'POST',
  );
  expect(JSON.parse(String(creates[1]?.[2]?.body)).scopes).toEqual([
    { app_id: 'app-one', environment_id: 'prod-one' },
  ]);
});

it('caps selection at 50 scopes and keeps the selected project as the default', async () => {
  mockRequests();
  const manyProjects = Array.from({ length: 51 }, (_, index) => ({
    appId: `app-${index}`,
    environmentId: `prod-${index}`,
    name: `Project ${index}`,
    environment: 'production',
  }));
  const current = { appId: 'app-0', environmentId: 'prod-0' };
  render(<WorkspacePanel ownerToken="" project={current} projects={manyProjects} />);
  await openTokenForm();
  expect(screen.getByRole('checkbox', { name: /Project 0 · production/ })).toBeChecked();
  for (let index = 1; index < 50; index++)
    fireEvent.click(
      screen.getByRole('checkbox', { name: new RegExp(`Project ${index} · production`) }),
    );
  expect(screen.getByText('50 of 50 scopes selected')).toBeVisible();
  expect(screen.getByRole('checkbox', { name: /Project 50 · production/ })).toBeDisabled();
});

it('drops selected pairs that disappear when the project inventory refreshes', async () => {
  mockRequests();
  const { rerender } = render(
    <WorkspacePanel ownerToken="" project={selected} projects={projects} />,
  );
  await openTokenForm();
  fireEvent.click(screen.getByRole('checkbox', { name: /Papertrail · production/ }));
  rerender(<WorkspacePanel ownerToken="" project={selected} projects={[projects[0]!]} />);
  expect(screen.queryByRole('checkbox', { name: /Papertrail · production/ })).toBeNull();
  expect(screen.getByText('1 of 50 scopes selected')).toBeVisible();

  fireEvent.click(screen.getByRole('button', { name: 'create API token' }));
  await waitFor(() =>
    expect(
      ownerFetch.mock.calls.some(
        ([path, , init]) => path === '/v1/workspace/api-tokens' && init?.method === 'POST',
      ),
    ).toBe(true),
  );
  const create = ownerFetch.mock.calls.find(
    (call) => call[0] === '/v1/workspace/api-tokens' && call[2]?.method === 'POST',
  );
  expect(JSON.parse(String(create?.[2]?.body)).scopes).toEqual([
    { app_id: 'app-one', environment_id: 'prod-one' },
  ]);
});
