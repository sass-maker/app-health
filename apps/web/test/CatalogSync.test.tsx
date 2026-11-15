import type { ComponentProps, MouseEvent } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CatalogSync, CATALOG_SYNC_EVENT } from '../src/CatalogSync.js';
import {
  selectWorkspace,
  updateWorkspaceRole,
  workspaceScope,
} from '../src/lib/workspace-scope.js';

const retainedButton = vi.hoisted(() => ({ invoke: undefined as (() => void) | undefined }));
vi.mock('@saas-maker/ui/components/button', () => ({
  Button: ({ size: _size, ...props }: ComponentProps<'button'> & { size?: string }) => {
    retainedButton.invoke = () => props.onClick?.({} as MouseEvent<HTMLButtonElement>);
    return <button {...props} />;
  },
}));

const source = {
  catalogSchemaVersion: 2,
  ownerNotes: 'PRIVATE_CANARY',
  projects: [
    {
      id: 'app-health',
      name: 'App Health',
      lifecycle: { status: 'retired', portfolioStatus: 'active' },
      classification: { kind: 'platform', futureForm: 'support-tool' },
      deployment: { authModel: 'public-persistent' },
      repositories: { localPath: '/private/canary' },
      systems: {
        appHealth: {
          browserVisitors: { applicability: 'not-applicable' },
          nativeSessions: 'unknown',
          serverRequests: 'applicable',
        },
        probe: { journeys: [{ journey: 'home', url: 'https://ignored.invalid/' }] },
      },
    },
  ],
};
function file(value: unknown, text?: () => Promise<string>) {
  return { size: 1000, text: text ?? (async () => JSON.stringify(value)) } as File;
}
const catalogStatus = {
  source: null,
  projection_hash: null,
  project_count: null,
  updated_at: null,
  mapped_catalog_ids: ['app-health'],
  unlinked_apps: [],
};
function owner() {
  updateWorkspaceRole('owner', workspaceScope().epoch);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  selectWorkspace('');
});

it('previews explicit active metadata, sends only the allowlist, and refreshes inventory after a save', async () => {
  owner();
  let uploaded: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        uploaded = JSON.parse(String(init.body));
        return Response.json({ project_count: 1 });
      }
      if (path === '/v1/apps') return Response.json({ apps: [] });
      return Response.json(catalogStatus);
    }),
  );
  const listener = vi.fn();
  window.addEventListener(CATALOG_SYNC_EVENT, listener);
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  expect(await screen.findByText('1 active projects')).toBeTruthy();
  expect(screen.getByText('1 support-tool')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Synchronize active portfolio' }));
  await waitFor(() => expect(listener).toHaveBeenCalledOnce());
  expect(JSON.stringify(uploaded)).not.toMatch(/PRIVATE_CANARY|localPath|ignored.invalid/);
  expect(uploaded).toMatchObject({
    projects: [
      {
        browser_visitors: 'not_applicable',
        native_sessions: 'unknown',
        server_requests: 'applicable',
      },
    ],
  });
  expect(
    screen.getByText('Synchronized 1 active projects and their monitoring policy.'),
  ).toBeTruthy();
  window.removeEventListener(CATALOG_SYNC_EVENT, listener);
});

it('rejects malformed and incomplete catalog files and reports save conflicts', async () => {
  owner();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_path: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({ error: 'Catalog changed. Reload and retry.' }, { status: 409 })
        : Response.json(catalogStatus),
    ),
  );
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(null, async () => '{')] },
  });
  expect(await screen.findByText('Choose a valid canonical catalog JSON file.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  await screen.findByText('1 active projects');
  fireEvent.click(screen.getByRole('button', { name: 'Synchronize active portfolio' }));
  expect(await screen.findByText('Catalog changed. Reload and retry.')).toBeTruthy();
});

it('drops pending file parsing and clears the preview when workspace scope changes', async () => {
  owner();
  const fetch = vi.fn(async () => Response.json(catalogStatus));
  vi.stubGlobal('fetch', fetch);
  let finish!: (value: string) => void;
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: {
      files: [
        file(
          source,
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
      ],
    },
  });
  act(() => selectWorkspace('different-workspace'));
  await act(async () => finish(JSON.stringify(source)));
  expect(screen.queryByLabelText('Catalog preview')).toBeNull();
  expect(fetch.mock.calls).toHaveLength(1);
});

it('does not expose the owner import control to token, editor or viewer sessions', () => {
  owner();
  const view = render(<CatalogSync ownerToken="token" />);
  expect(screen.queryByLabelText('Canonical catalog JSON')).toBeNull();
  act(() => updateWorkspaceRole('viewer', workspaceScope().epoch));
  view.rerender(<CatalogSync ownerToken="" />);
  expect(screen.queryByLabelText('Canonical catalog JSON')).toBeNull();
});

it('ignores a late upload response after the workspace changes and never refreshes the new workspace from it', async () => {
  owner();
  let finish!: (response: Response) => void;
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return await new Promise<Response>((resolve) => {
        finish = resolve;
      });
    if (path === '/v1/apps') throw new Error('A stale upload must not refresh inventory');
    return Response.json(catalogStatus);
  });
  vi.stubGlobal('fetch', fetch);
  const listener = vi.fn();
  window.addEventListener(CATALOG_SYNC_EVENT, listener);
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  await screen.findByText('1 active projects');
  fireEvent.click(screen.getByRole('button', { name: 'Synchronize active portfolio' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  act(() => selectWorkspace('another-workspace'));
  await act(async () => finish(Response.json({ project_count: 1 })));
  expect(screen.queryByLabelText('Catalog preview')).toBeNull();
  expect(listener).not.toHaveBeenCalled();
  expect(fetch.mock.calls.some(([path]) => path === '/v1/apps')).toBe(false);
  window.removeEventListener(CATALOG_SYNC_EVENT, listener);
});

it('shows existing mapping and new metadata counts and blocks unlinked projects before posting', async () => {
  owner();
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({
      ...catalogStatus,
      mapped_catalog_ids: [],
      unlinked_apps: [{ app_id: 'manual-project-id', name: 'Existing telemetry project' }],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  expect(
    await screen.findByText('0 selected projects already mapped · 1 new metadata projects'),
  ).toBeTruthy();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Review 1 unlinked workspace projects before synchronizing.',
  );
  expect(screen.getByText('manual-project-id')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Synchronize active portfolio' })).toBeDisabled();
  expect(fetch.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(
    true,
  );
});

it('requires an explicit outside acknowledgement and sends it only as request control metadata', async () => {
  owner();
  let uploaded: { preserve_outside_catalog_app_ids?: string[]; projects?: unknown } | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        uploaded = JSON.parse(String(init.body));
        return Response.json({ project_count: 1 });
      }
      if (path === '/v1/apps') return Response.json({ apps: [] });
      return Response.json({
        ...catalogStatus,
        unlinked_apps: [{ app_id: 'external-app', name: 'External project' }],
      });
    }),
  );
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  await screen.findByText('1 active projects');
  const synchronize = screen.getByRole('button', { name: 'Synchronize active portfolio' });
  expect(synchronize).toBeDisabled();
  fireEvent.click(
    screen.getByRole('checkbox', { name: /Keep External project outside this catalog/ }),
  );
  expect(synchronize).toBeEnabled();
  fireEvent.click(synchronize);
  await waitFor(() => expect(uploaded).not.toBeNull());
  expect(uploaded).toMatchObject({ preserve_outside_catalog_app_ids: ['external-app'] });
  expect(JSON.stringify((uploaded as { projects?: unknown } | null)?.projects)).not.toContain(
    'external-app',
  );
});

it('rejects a retained submit handler immediately after workspace selection changes', async () => {
  owner();
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json(catalogStatus));
  vi.stubGlobal('fetch', fetch);
  render(<CatalogSync ownerToken="" />);
  fireEvent.change(screen.getByLabelText('Canonical catalog JSON'), {
    target: { files: [file(source)] },
  });
  await screen.findByText('1 active projects');
  const submitFromPreviousWorkspace = retainedButton.invoke!;
  act(() => {
    selectWorkspace('new-workspace');
    submitFromPreviousWorkspace();
  });
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(screen.queryByLabelText('Catalog preview')).toBeNull();
});
