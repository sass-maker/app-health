import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  expect(screen.getByRole('alert')).toHaveTextContent('Showing the retained snapshot');
  expect(screen.getByLabelText('Search observations')).toHaveValue('does-not-exist');
});

it('retains scope and search while a same-owner snapshot reload is pending and completes', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(operationsFixture()))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
  );
  render(<OperationsView ownerToken="owner" />);
  await screen.findByText('Current build failed');
  fireEvent.click(screen.getByRole('button', { name: 'public 1' }));
  fireEvent.change(screen.getByLabelText('Search observations'), { target: { value: 'build' } });
  fireEvent.click(screen.getByRole('button', { name: 'reload snapshot' }));
  expect(screen.getByRole('button', { name: 'reload snapshot' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'public 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Search observations')).toHaveValue('build');
  expect(screen.getByText('Current build failed')).toBeTruthy();
  finish(Response.json(operationsFixture()));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'reload snapshot' })).toBeEnabled(),
  );
  expect(screen.getByRole('button', { name: 'public 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByLabelText('Search observations')).toHaveValue('build');
});

it('explains a forbidden workspace instead of advising another collection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 403 })),
  );
  render(<OperationsView ownerToken="owner" />);
  expect(await screen.findByRole('alert')).toHaveTextContent("local owner's personal workspace");
  expect(screen.getByRole('alert')).not.toHaveTextContent('Collect the sources again');
});

it.each([401, 403])(
  'clears retained private data when a reload loses authorization (%s)',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(operationsFixture()))
        .mockResolvedValueOnce(new Response(null, { status })),
    );
    render(<OperationsView ownerToken="owner" />);
    await screen.findByText('Current build failed');
    fireEvent.click(screen.getByRole('button', { name: 'reload snapshot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("local owner's personal workspace");
    expect(screen.queryByText('Current build failed')).toBeNull();
  },
);

it('keeps an unavailable Site Health connection in attention while security permission gaps stay separate', async () => {
  const snapshot = operationsFixture();
  snapshot.families.push({
    id: 'collectors',
    name: 'Data collector health',
    producer: 'Site Health',
    collector: 'Loopback API',
    connected: false,
    limitations: 'Source connection unavailable.',
  });
  snapshot.feeds.push({
    ...snapshot.feeds[2],
    id: 'site-health-offline',
    familyId: 'collectors',
    name: 'Site Health connection',
    projectIds: [],
  });
  snapshot.observations.push({
    ...snapshot.observations[2],
    id: 'site-health-failed',
    feedId: 'site-health-offline',
    projectId: null,
    title: 'Site Health connection failed',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(snapshot)),
  );
  render(<OperationsView ownerToken="owner" />);
  expect(await screen.findByText('Site Health connection failed')).toBeTruthy();
  expect(screen.queryByText('Security access is unavailable')).toBeNull();
});

it('orders equal-severity observations newest first and leaves unknown dates last', async () => {
  const snapshot = operationsFixture();
  const base = snapshot.observations[0];
  snapshot.observations = [
    { ...base, id: 'older', title: 'Old GitHub error', observedAt: '2026-01-01T00:00:00Z' },
    { ...base, id: 'unknown', title: 'Undated error', observedAt: null },
    { ...base, id: 'newer', title: 'New probe error', observedAt: '2026-11-07T00:00:00Z' },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(snapshot)),
  );
  render(<OperationsView ownerToken="owner" />);
  await screen.findByText('New probe error');
  const rows = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent);
  expect(rows).toEqual(['New probe error', 'Old GitHub error', 'Undated error']);
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
