import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCatalogRevision } from '../src/useCatalogRevision.js';
import { CATALOG_SYNC_EVENT } from '../src/CatalogSync.js';
import {
  refreshWorkspace,
  selectWorkspace,
  updateWorkspaceRole,
  workspaceScope,
} from '../src/lib/workspace-scope.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  selectWorkspace('');
});
function Reader() {
  useCatalogRevision(true, 40, true);
  return null;
}
function status(hash: string, count = 40) {
  return Response.json({
    source: 'saas-maker',
    projection_hash: hash.repeat(64),
    updated_at: 1,
    project_count: count,
    mapped_catalog_ids: [],
    unlinked_apps: [],
  });
}
it('keeps unchanged polls quiet and invalidates an open dashboard when the canonical revision changes', async () => {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  let revision = 'a';
  let count = 40;
  const fetcher = vi.fn(async () => status(revision, count));
  vi.stubGlobal('fetch', fetcher);
  const received: CustomEvent[] = [];
  const listener = (event: Event) => {
    received.push(event as CustomEvent);
    refreshWorkspace();
  };
  window.addEventListener(CATALOG_SYNC_EVENT, listener);
  render(<Reader />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await act(async () => {
    fireEvent.focus(window);
  });
  expect(received).toHaveLength(1);
  revision = 'b';
  count = 39;
  const epoch = workspaceScope().epoch;
  await act(async () => {
    fireEvent.focus(window);
  });
  expect(received).toHaveLength(2);
  expect(received[1]!.detail).toEqual({ epoch, listed: null, projectCount: 39, automatic: true });
  expect(workspaceScope().epoch).toBe(epoch + 1);
  window.removeEventListener(CATALOG_SYNC_EVENT, listener);
});
it('rejects a late status response from an older workspace epoch', async () => {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const listener = vi.fn();
  window.addEventListener(CATALOG_SYNC_EVENT, listener);
  render(<Reader />);
  act(() => refreshWorkspace());
  await act(async () => finish(status('b', 39)));
  expect(listener).not.toHaveBeenCalled();
  window.removeEventListener(CATALOG_SYNC_EVENT, listener);
});

it('refreshes an initially stale same-count inventory exactly once when the first canonical hash is observed', async () => {
  updateWorkspaceRole('owner', workspaceScope().epoch);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => status('b', 40)),
  );
  const received: CustomEvent[] = [];
  const listener = (event: Event) => {
    received.push(event as CustomEvent);
    refreshWorkspace();
  };
  window.addEventListener(CATALOG_SYNC_EVENT, listener);
  render(<Reader />);
  await waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]!.detail).toMatchObject({ listed: null, projectCount: 40, automatic: true });
  await act(async () => {
    fireEvent.focus(window);
  });
  expect(received).toHaveLength(1);
  window.removeEventListener(CATALOG_SYNC_EVENT, listener);
});
