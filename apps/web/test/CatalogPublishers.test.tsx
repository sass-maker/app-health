import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogPublishers } from '../src/CatalogPublishers.js';
import {
  selectWorkspace,
  updateWorkspaceRole,
  workspaceScope,
} from '../src/lib/workspace-scope.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  selectWorkspace('');
});
function owner() {
  updateWorkspaceRole('owner', workspaceScope().epoch);
}
function open() {
  const details = screen.getByText('Automatic catalog updates').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
}
const status = {
  source: 'saas-maker',
  projection_hash: 'a'.repeat(64),
  updated_at: 1,
  project_count: 40,
  mapped_catalog_ids: [],
  unlinked_apps: [{ app_id: 'outside', name: 'External project' }],
};

it('requires a reviewed connection, explicit outside decisions and catalog-only consent before approval', async () => {
  owner();
  let approved: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/catalog/sync') return Response.json(status);
      if (path.includes('/pairing?')) return Response.json({ label: 'Fleet Mac' });
      if (path.endsWith('/approve')) {
        approved = JSON.parse(String(init?.body));
        return Response.json({ publisher_id: '11111111-1111-4111-8111-111111111111' });
      }
      return Response.json({ publishers: [] });
    }),
  );
  render(<CatalogPublishers />);
  open();
  fireEvent.change(screen.getByLabelText('Connection code from your Mac'), {
    target: { value: 'ABCDEF123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review connection' }));
  expect(await screen.findByText('Connect Fleet Mac')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Connect automatic updates' })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText('Allow automatic updates to this workspace from this connection.'),
  );
  expect(screen.getByRole('button', { name: 'Connect automatic updates' })).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      'Keep External project outside this catalog. Its history and keys remain available.',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Connect automatic updates' }));
  await waitFor(() =>
    expect(approved).toEqual({
      code: 'ABCDEF123456',
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: ['outside'],
    }),
  );
  expect(await screen.findByText(/Connected. This Mac checks/)).toBeTruthy();
});

it('shows an inactive publisher and safe actionable errors without claiming synchronization', async () => {
  owner();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        publishers: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            label: 'Fleet Mac',
            approved_at: 1,
            revoked_at: null,
            last_attempt_at: 2,
            last_success_at: null,
            last_error: 'review_required',
          },
        ],
      }),
    ),
  );
  render(<CatalogPublishers />);
  open();
  expect(
    await screen.findByText(/Outside-project decisions changed and need owner review/),
  ).toBeTruthy();
  expect(screen.getByText('Waiting for the first check-in.')).toBeTruthy();
  expect(screen.getByText(/Publisher has not checked in recently/)).toBeTruthy();
});

it('discards a connection review that completes after a workspace switch', async () => {
  owner();
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      path.includes('/pairing?')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json(path === '/v1/catalog/sync' ? status : { publishers: [] })),
    ),
  );
  render(<CatalogPublishers />);
  open();
  fireEvent.change(screen.getByLabelText('Connection code from your Mac'), {
    target: { value: 'ABCDEF123456' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review connection' }));
  act(() => selectWorkspace('other'));
  await act(async () => finish(Response.json({ label: 'Old private connection' })));
  expect(screen.queryByText('Connect Old private connection')).toBeNull();
});

it('reviews the live outside list and resumes an approved connection without terminal re-pairing', async () => {
  owner();
  let reviewed: unknown;
  const id = '11111111-1111-4111-8111-111111111111';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/catalog/sync') return Response.json(status);
      if (path.endsWith('/review')) {
        reviewed = JSON.parse(String(init?.body));
        return Response.json({ publisher_id: id });
      }
      return Response.json({
        publishers: [
          {
            id,
            label: 'Fleet Mac',
            approved_at: 1,
            revoked_at: null,
            last_attempt_at: Date.now(),
            last_success_at: 1,
            last_error: 'review_required',
          },
        ],
      });
    }),
  );
  render(<CatalogPublishers />);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'Review outside projects' }));
  expect(await screen.findByText('Review Fleet Mac')).toBeTruthy();
  const resume = screen.getByRole('button', { name: 'Resume automatic updates' });
  expect(resume).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      'Keep External project outside this catalog. Its history and keys remain available.',
    ),
  );
  fireEvent.click(
    screen.getByLabelText('Allow automatic updates to this workspace from this connection.'),
  );
  fireEvent.click(resume);
  await waitFor(() =>
    expect(reviewed).toEqual({
      publisher_id: id,
      allow_automatic_updates: true,
      preserve_outside_catalog_app_ids: ['outside'],
    }),
  );
});
