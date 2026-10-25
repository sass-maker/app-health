import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { ownerFetch } from '../src/lib/owner-fetch.js';
import { selectWorkspace, useWorkspaceScope, workspaceScope } from '../src/lib/workspace-scope.js';
import { accountResourceClient } from '../src/lib/account-resource-client.js';

afterEach(() => {
  act(() => selectWorkspace(''));
  vi.unstubAllGlobals();
});
it('captures selected workspace headers, aborts old reads and prevents late replies from populating the new workspace', async () => {
  const pending: { resolve: (value: Response) => void; signal: AbortSignal; headers: Headers }[] =
    [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_path: unknown, init: RequestInit) =>
        new Promise<Response>((resolve) =>
          pending.push({ resolve, signal: init.signal!, headers: new Headers(init.headers) }),
        ),
    ),
  );
  function Data() {
    const [text, setText] = useState('loading');
    useEffect(() => {
      let cancelled = false;
      void ownerFetch('/v1/apps', '')
        .then((response) => response.text())
        .then((body) => {
          if (!cancelled) setText(body);
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, []);
    return <p>{text}</p>;
  }
  function Dashboard() {
    const scope = useWorkspaceScope();
    return <Data key={scope.epoch} />;
  }
  act(() => selectWorkspace('ws-first'));
  render(<Dashboard />);
  expect(pending[0].headers.get('x-app-health-workspace')).toBe('ws-first');
  const oldCache = accountResourceClient('');
  act(() => selectWorkspace('ws-second'));
  expect(pending[0].signal.aborted).toBe(true);
  expect(pending[1].headers.get('x-app-health-workspace')).toBe('ws-second');
  expect(accountResourceClient('')).not.toBe(oldCache);
  pending[1].resolve(new Response('second workspace'));
  await waitFor(() => expect(screen.getByText('second workspace')).toBeVisible());
  pending[0].resolve(new Response('first private workspace'));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText('first private workspace')).toBeNull();
  expect(workspaceScope().id).toBe('ws-second');
});

it('sends neither workspace selectors to invitation acceptance nor browser-stored API credentials', async () => {
  act(() => selectWorkspace('ws-shared'));
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await ownerFetch('/v1/invites/accept', '', { method: 'POST', body: '{}' });
  expect(new Headers(fetch.mock.calls[0][1].headers).has('x-app-health-workspace')).toBe(false);
  await ownerFetch('/v1/analytics/report?app_id=app&environment_id=env', 'aha_one_time');
  expect(new Headers(fetch.mock.calls[1][1].headers).get('authorization')).toBe(
    'Bearer aha_one_time',
  );
  expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('aha_one_time');
});
