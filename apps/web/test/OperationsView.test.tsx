import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationsView } from '../src/OperationsView.js';
import { operationsFixture } from './operations-fixture.js';

afterEach(() => vi.unstubAllGlobals());

it('shows actual scope, keeps inaccessible feeds out of the attention inbox, and filters public/internal', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(operationsFixture())),
  );
  render(<OperationsView ownerToken="owner" />);
  expect(await screen.findByText('Current build failed')).toBeTruthy();
  expect(screen.getByText('Private usage is stale')).toBeTruthy();
  expect(screen.queryByText('Security access is unavailable')).toBeNull();
  expect(screen.getByText('3 feeds checked · 2 with readable data')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'public 1' }));
  expect(screen.getByText('Current build failed')).toBeTruthy();
  expect(screen.queryByText('Private usage is stale')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'internal 1' }));
  expect(screen.queryByText('Current build failed')).toBeNull();
  expect(screen.getByText('Private usage is stale')).toBeTruthy();
  expect(screen.getByText('0 products · 0 experiments · 1 platforms')).toBeTruthy();
});
it('shows producers, collectors and explicit missing connections in the source inventory', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(operationsFixture())),
  );
  render(<OperationsView ownerToken="owner" />);
  await screen.findByText('Current build failed');
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'sources 2' }), {
    button: 0,
    ctrlKey: false,
  });
  expect(screen.getByLabelText('Source inventory')).toHaveTextContent('Produced by GitHub Actions');
  expect(screen.getByText('Automatic repairs')).toBeTruthy();
  expect(screen.getByText('No repair executor connected.')).toBeTruthy();
  expect(screen.getAllByText('not connected in scope').length).toBeGreaterThan(0);
});
it('searches observations and labels a failed API without inventing sample rows', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(operationsFixture()))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  render(<OperationsView ownerToken="owner" />);
  await screen.findByText('Current build failed');
  fireEvent.change(screen.getByLabelText('Search observations'), {
    target: { value: 'does-not-exist' },
  });
  expect(screen.getByText('No observations match this view.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'reload snapshot' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('503');
  expect(screen.queryByText('Current build failed')).toBeNull();
});
it('does not keep previous owner data visible while changing owner context', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(operationsFixture()))
      .mockImplementation(() => new Promise<Response>(() => {})),
  );
  const view = render(<OperationsView ownerToken="first" />);
  await screen.findByText('Current build failed');
  view.rerender(<OperationsView ownerToken="second" />);
  expect(screen.queryByText('Current build failed')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Reading');
});
it('shows an explicit not-connected state when the production route is absent', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 404 })),
  );
  render(<OperationsView ownerToken="owner" />);
  expect(await screen.findByText('Operations sources are not connected here.')).toBeTruthy();
  expect(screen.queryByText('Current build failed')).toBeNull();
});
