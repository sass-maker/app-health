import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AnalyticsSharing } from '../src/AnalyticsSharing.js';
const project = {
  appId: 'app-one',
  environmentId: 'prod-one',
  name: 'Northstar',
  environment: 'production',
};
const share = {
  id: 'one-link-id',
  app_id: project.appId,
  environment_id: project.environmentId,
  created_at: Date.now(),
  revoked_at: null,
};
const token = `ahs_${'x'.repeat(43)}`;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('creates a scope-specific public link and embed, exposes copy fallback, then revokes', async () => {
  const request = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toContain('app_id=app-one&environment_id=prod-one');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner-only');
    if (init.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ include_breakdowns: false });
      return Response.json({ share, token }, { status: 201 });
    }
    if (init.method === 'DELETE') return Response.json({ revoked: true });
    return Response.json({ shares: [] });
  });
  vi.stubGlobal('fetch', request);
  const writeText = vi.fn().mockRejectedValue(new Error('unavailable'));
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<AnalyticsSharing project={project} ownerToken="owner-only" />);
  const create = screen.getByRole('button', { name: 'Create public link' });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  const link = await screen.findByLabelText('Public page');
  expect(link).toHaveValue(`${location.origin}/live#token=${token}`);
  const embed = screen.getByLabelText('Embed on your product') as HTMLTextAreaElement;
  expect(embed.value).toContain('/live?embed=1#token=');
  expect(embed.value).not.toContain('owner-only');
  expect(embed.value).toContain('referrerpolicy="no-referrer"');
  fireEvent.click(screen.getByRole('button', { name: 'Copy public link' }));
  expect(await screen.findByText(/The field is selected/)).toBeVisible();
  expect(link).toHaveFocus();
  expect((link as HTMLInputElement).selectionEnd).toBe((link as HTMLInputElement).value.length);
  writeText.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Copy embed code' }));
  expect(await screen.findByText('Copied to clipboard.')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke link one-link' }));
  expect(await screen.findByText('Revoked', { exact: true })).toBeVisible();
  expect(screen.queryByLabelText('Public page')).toBeNull();
});

it('requires an explicit opt-in for breakdowns and updates an active share', async () => {
  const requests: Array<{ method?: string; body?: string }> = [];
  const detailed = { ...share, include_breakdowns: false };
  const createdShare = { ...detailed, id: 'two-link-id' };
  const request = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push({ method: init.method, body: init.body as string | undefined });
    if (init.method === 'POST')
      return Response.json({ share: createdShare, token }, { status: 201 });
    if (init.method === 'PATCH')
      return Response.json({ share: { ...detailed, include_breakdowns: true } });
    return Response.json({ shares: [detailed] });
  });
  vi.stubGlobal('fetch', request);
  render(<AnalyticsSharing project={project} ownerToken="owner-only" />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create public link' })).toBeEnabled(),
  );
  const createChoice = screen.getByRole('checkbox', { name: /Share top routes and sources/i });
  fireEvent.click(createChoice);
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }));
  await screen.findByLabelText('Public page');
  expect(JSON.parse(requests.find((entry) => entry.method === 'POST')?.body ?? '{}')).toEqual({
    include_breakdowns: true,
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Create public link' })).toBeEnabled(),
  );
  const activeChoice = document.getElementById(
    'analytics-share-breakdowns-one-link-id',
  ) as HTMLInputElement | null;
  expect(activeChoice).toBeTruthy();
  fireEvent.click(activeChoice!);
  await waitFor(() => expect(requests.some((entry) => entry.method === 'PATCH')).toBe(true));
  expect(JSON.parse(requests.find((entry) => entry.method === 'PATCH')?.body ?? '{}')).toEqual({
    include_breakdowns: true,
  });
});
it('shows load failure without claiming sharing is off, then retries', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'Not available' }, { status: 503 }))
    .mockResolvedValue(Response.json({ shares: [share] }));
  vi.stubGlobal('fetch', request);
  render(<AnalyticsSharing project={project} ownerToken="" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Not available');
  expect(screen.queryByText(/Sharing is off/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh links' }));
  expect(await screen.findByRole('button', { name: 'Revoke link one-link' })).toBeVisible();
});
