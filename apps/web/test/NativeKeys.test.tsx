import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeKeys } from '../src/NativeKeys.js';

const project = { appId: 'project-one', environmentId: 'environment-one' };
const record = {
  id: 'f4ee2410-08a5-4aac-87a3-304d7d33b163',
  workspace_id: 'workspace',
  app_id: project.appId,
  environment_id: project.environmentId,
  created_at: 1000,
  revoked_at: null,
};
const key = `ahk_native_${'a'.repeat(64)}`;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function show() {
  return render(
    <NativeKeys project={project} ownerToken="owner" ingestOrigin="https://ingest.example.com" />,
  );
}
it('creates a scoped native key, provides copy fallback and confirms revocation', async () => {
  const request = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toContain('app_id=project-one&environment_id=environment-one');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner');
    if (init.method === 'POST') return Response.json({ key, record }, { status: 201 });
    if (init.method === 'DELETE') return Response.json({ revoked: true });
    return Response.json({ keys: [] });
  });
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn().mockRejectedValue(new Error('unavailable')) },
  });
  show();
  const create = screen.getByRole('button', { name: 'Create native public key' });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  expect(await screen.findByLabelText('Native public key')).toHaveValue(key);
  expect(screen.getByText(/let health = try AppHealthClient/)).toHaveTextContent(
    'https://ingest.example.com',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy native key' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Select the key above');
  fireEvent.click(screen.getByRole('button', { name: 'Revoke native key' }));
  expect(request.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke now' }));
  expect(await screen.findByText('Revoked')).toBeVisible();
  expect(screen.queryByLabelText('Native public key')).toBeNull();
});
it('caps active keys and recovers from an invalid list response', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ keys: [{}] }))
      .mockResolvedValue(
        Response.json({
          keys: Array.from({ length: 5 }, (_, index) => ({
            ...record,
            id: `f4ee2410-08a5-4aac-87a3-304d7d33b16${index}`,
          })),
        }),
      ),
  );
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
  fireEvent.click(screen.getByRole('button', { name: 'Retry native keys' }));
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Revoke native key' })).toHaveLength(5),
  );
  expect(screen.getByRole('button', { name: 'Create native public key' })).toBeDisabled();
});
it('times out a stalled load and aborts it when unmounted', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise(() => {});
    }),
  );
  const view = show();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('timed out');
  expect(signal?.aborted).toBe(true);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
