import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  AnalysisRecord,
  type AnalysisDefinition,
  type AnalysisQuery,
  type AnalysisReport,
} from '@app-health/contracts';
import { Conversions, SavedSegments } from '../src/Conversions.js';

const query: AnalysisQuery = { app_id: 'app-one', environment_id: 'production', range: '24h' };
const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];
function record(index: number, definition: AnalysisDefinition) {
  return AnalysisRecord.parse({ id: ids[index], definition, created_at: 1, updated_at: 2 });
}
const goal = record(0, {
  kind: 'goal',
  name: 'Paid signup',
  step: { type: 'event', target: 'signup.completed', property: 'plan', equals: 'pro' },
});
const funnel = record(1, {
  kind: 'funnel',
  name: 'Activation flow',
  steps: [
    { type: 'page', target: '/pricing/*' },
    { type: 'event', target: 'activated', property: 'seats', equals: 2 },
  ],
  window_ms: 3600000,
  segment: { source: 'Reddit' },
});
const segment = record(2, {
  kind: 'segment',
  name: 'Search audience',
  filters: { source: 'Google', country: 'US' },
});
function report(records = [goal, funnel], patch: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    from: 0,
    to: 100,
    source: 'archive',
    complete: false,
    coverage_note: 'Observed archived events only.',
    events: 8,
    sessions: 4,
    visitors: 3,
    unidentified_sessions: 1,
    values: [{ name: 'signup.completed', occurrences: 2, value: 49 }],
    properties: [
      {
        key: 'plan',
        values: [
          { value: 'pro', count: 2 },
          { value: false, count: 1 },
          { value: 2, count: 1 },
        ],
      },
    ],
    goals: records
      .filter((row) => row.definition.kind === 'goal')
      .map((row) => ({
        id: row.id,
        name: row.definition.name,
        occurrences: 2,
        visitors: 1,
        sessions: 1,
        conversion_rate: 1 / 3,
        value: 49,
      })),
    funnels: records
      .filter((row) => row.definition.kind === 'funnel')
      .map((row) => ({
        id: row.id,
        name: row.definition.name,
        conversion_rate: 0.5,
        median_conversion_ms: 5000,
        steps: [
          { target: '/computed-result-target', sessions: 2, dropoff: 0, conversion_rate: 1 },
          { target: 'activated', sessions: 1, dropoff: 1, conversion_rate: 0.5 },
        ],
      })),
    ...patch,
  };
}
function server(initial = [goal, funnel]) {
  let records = [...initial];
  const request = vi.fn(async (url: URL, init: RequestInit) => {
    const target = new URL(String(url));
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner');
    if (target.pathname.endsWith('/conversions')) return Response.json(report(records));
    if (init.method === 'POST') {
      const created = record(0, JSON.parse(String(init.body)));
      records.push(created);
      return Response.json(created);
    }
    if (init.method === 'PUT') {
      const index = records.findIndex((row) => target.pathname.endsWith(row.id));
      records[index] = { ...records[index], definition: JSON.parse(String(init.body)) };
      return Response.json(records[index]);
    }
    if (init.method === 'DELETE')
      records = records.filter((row) => !target.pathname.endsWith(row.id));
    return Response.json({ records });
  });
  vi.stubGlobal('fetch', request);
  return request;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const open = () => fireEvent.click(screen.getByRole('button', { name: 'explore conversions' }));

it('loads conversions on demand, exposes coverage/property types and creates a page goal', async () => {
  const request = server([]);
  render(
    <Conversions
      query={{ ...query, event: 'signup.completed', filters: { country: 'US' } }}
      ownerToken="owner"
    />,
  );
  expect(request).not.toHaveBeenCalled();
  open();
  expect(await screen.findByText(/create a goal from an event/)).toBeVisible();
  expect(screen.getByText(/Observed archived events only/)).toBeVisible();
  expect(screen.getByText('signup.completed: 2 occurrences · value 49')).toBeVisible();
  expect(screen.getByText('(boolean)')).toBeVisible();
  expect(screen.getByText('(number)')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'new goal or funnel' }));
  fireEvent.change(screen.getByLabelText('Conversion name'), { target: { value: 'Pricing' } });
  fireEvent.change(screen.getByLabelText('Step 1 target'), { target: { value: '/pricing' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('heading', { name: 'Pricing' })).toBeVisible();
  const post = request.mock.calls.find(([, init]) => init.method === 'POST');
  expect(JSON.parse(String(post?.[1].body))).toEqual({
    kind: 'goal',
    name: 'Pricing',
    step: { type: 'page', target: '/pricing' },
  });
  expect(String(request.mock.calls[0][0])).toContain('event=signup.completed');
  expect(new URL(String(request.mock.calls[0][0])).searchParams.get('filters')).toBe(
    '{"country":"US"}',
  );
  fireEvent.click(screen.getByRole('button', { name: 'hide conversions' }));
  expect(screen.queryByRole('heading', { name: 'Pricing' })).toBeNull();
});

it('edits goals and funnels using original definitions, including properties, segments and window', async () => {
  const request = server();
  render(<Conversions query={query} ownerToken="owner" />);
  open();
  await screen.findByRole('heading', { name: 'Paid signup' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Paid signup' }));
  expect(screen.getByLabelText('Step 1 target')).toHaveValue('signup.completed');
  expect(screen.getByLabelText('Step 1 equals')).toHaveValue('pro');
  fireEvent.change(screen.getByLabelText('Conversion name'), { target: { value: 'Pro signup' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('heading', { name: 'Pro signup' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Edit Activation flow' }));
  expect(screen.getByLabelText('Step 1 target')).toHaveValue('/pricing/*');
  expect(screen.getByLabelText('Step 2 equals')).toHaveValue('2');
  expect(screen.getByLabelText('Conversion window hours')).toHaveValue(1);
  fireEvent.change(screen.getByLabelText('Conversion name'), {
    target: { value: 'Faster activation' },
  });
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('heading', { name: 'Faster activation' })).toBeVisible();
  const updates = request.mock.calls.filter(([, init]) => init.method === 'PUT');
  expect(String(updates[0][0])).toContain(
    `/definitions/${goal.id}?app_id=app-one&environment_id=production`,
  );
  expect(JSON.parse(String(updates[1][1].body))).toMatchObject({
    steps: [
      { type: 'page', target: '/pricing/*' },
      { type: 'event', target: 'activated', property: 'seats', equals: 2 },
    ],
    segment: { source: 'Reddit' },
    window_ms: 3600000,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Delete Pro signup' }));
  await waitFor(() => expect(screen.queryByRole('heading', { name: 'Pro signup' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Delete Faster activation' }));
  await waitFor(() =>
    expect(screen.queryByRole('heading', { name: 'Faster activation' })).toBeNull(),
  );
});

it('surfaces load/delete/save errors and keeps the form available for retry', async () => {
  const request = server();
  render(<Conversions query={query} ownerToken="owner" />);
  open();
  await screen.findByRole('heading', { name: 'Paid signup' });
  request.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Paid signup' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Paid signup' }));
  request.mockResolvedValueOnce(Response.json({}, { status: 409 }));
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByText(/Retry without changing the form/)).toBeVisible();
  expect(screen.getByLabelText('Step 1 equals')).toHaveValue('pro');
  fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  request.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: 'refresh conversions' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Conversions could not load');
});

it('does not invent editable steps when the original definition cannot be loaded', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      String(url).includes('/conversions?')
        ? Response.json(report())
        : Response.json({}, { status: 503 }),
    ),
  );
  render(<Conversions query={{ ...query, event: 'empty' }} ownerToken="owner" />);
  open();
  await screen.findByRole('heading', { name: 'Activation flow' });
  expect(await screen.findByRole('alert')).toHaveTextContent('definitions could not load');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Activation flow' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Original definition unavailable');
  expect(screen.queryByRole('form')).toBeNull();
});

it('discards late reports, definition responses and an open editor when the project changes', async () => {
  let resolveReport: (value: Response) => void = () => {};
  let resolveDefinitions: (value: Response) => void = () => {};
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url, init) => {
      const target = new URL(String(url));
      if (target.searchParams.get('app_id') === 'app-two')
        return Promise.resolve(
          Response.json(
            target.pathname.endsWith('/conversions')
              ? report([], { properties: [] })
              : { records: [] },
          ),
        );
      signals.push(init.signal);
      return new Promise<Response>((resolve) => {
        if (target.pathname.endsWith('/conversions')) resolveReport = resolve;
        else resolveDefinitions = resolve;
      });
    }),
  );
  const view = render(<Conversions query={query} ownerToken="owner" />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'new goal or funnel' }));
  view.rerender(<Conversions query={{ ...query, app_id: 'app-two' }} ownerToken="owner" />);
  expect(screen.queryByRole('form')).toBeNull();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  open();
  await act(async () => {
    resolveReport(Response.json(report()));
    resolveDefinitions(Response.json({ records: [goal, funnel] }));
  });
  expect(await screen.findByText(/create a goal from an event/)).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Paid signup' })).toBeNull();
});

it('creates, applies and deletes named segments using current filters and scoped endpoints', async () => {
  const request = server([segment, goal]);
  const apply = vi.fn();
  render(
    <SavedSegments
      query={{ ...query, filters: { country: 'IN' } }}
      ownerToken="owner"
      onApply={apply}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Search audience' }));
  expect(apply).toHaveBeenCalledWith({ source: 'Google', country: 'US' });
  expect(screen.queryByRole('button', { name: 'Paid signup' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Segment name'), { target: { value: 'India visitors' } });
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('button', { name: 'India visitors' })).toBeVisible();
  expect(
    JSON.parse(String(request.mock.calls.find(([, init]) => init.method === 'POST')?.[1].body)),
  ).toEqual({ kind: 'segment', name: 'India visitors', filters: { country: 'IN' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete segment Search audience' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Search audience' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'hide saved segments' }));
  expect(screen.queryByLabelText('Segment name')).toBeNull();
});

it('shows segment failures and blocks stale scope reads and drafts from changing the current project', async () => {
  let resolveOld: (response: Response) => void = () => {};
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(Response.json({ records: [] }));
  vi.stubGlobal('fetch', request);
  const props = { ownerToken: 'owner', onApply: vi.fn() };
  const view = render(
    <SavedSegments {...props} query={{ ...query, filters: { country: 'IN' } }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  fireEvent.change(screen.getByLabelText('Segment name'), {
    target: { value: 'Old project draft' },
  });
  view.rerender(<SavedSegments {...props} query={{ ...query, app_id: 'app-two' }} />);
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  await act(async () => resolveOld(Response.json({ records: [segment] })));
  expect(screen.queryByRole('button', { name: 'Search audience' })).toBeNull();
  expect(screen.queryByLabelText('Segment name')).toBeNull();
  request.mockResolvedValueOnce(Response.json({}, { status: 503 }));
  fireEvent.click(screen.getByRole('button', { name: 'hide saved segments' }));
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved segments could not load');
});

it('does not let a late segment save clear another project draft or refresh its records', async () => {
  let finishSave: (response: Response) => void = () => {};
  const request = vi.fn((_url: URL, init: RequestInit) =>
    init.method === 'POST'
      ? new Promise<Response>((resolve) => {
          finishSave = resolve;
        })
      : Promise.resolve(Response.json({ records: [] })),
  );
  vi.stubGlobal('fetch', request);
  const props = { ownerToken: 'owner', onApply: vi.fn() };
  const view = render(
    <SavedSegments {...props} query={{ ...query, filters: { country: 'IN' } }} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  fireEvent.change(screen.getByLabelText('Segment name'), { target: { value: 'Old save' } });
  fireEvent.submit(screen.getByRole('form'));
  view.rerender(
    <SavedSegments
      {...props}
      query={{ ...query, app_id: 'app-two', filters: { country: 'US' } }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  fireEvent.change(screen.getByLabelText('Segment name'), { target: { value: 'Current draft' } });
  await act(async () => finishSave(Response.json(segment)));
  expect(screen.getByLabelText('Segment name')).toHaveValue('Current draft');
  expect(
    request.mock.calls.filter(
      ([url]) => new URL(String(url)).searchParams.get('app_id') === 'app-two',
    ),
  ).toHaveLength(1);
});

it('does not apply a late conversion save failure to another project editor', async () => {
  let failSave: (cause: Error) => void = () => {};
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL, init: RequestInit) => {
      if (init.method === 'POST')
        return new Promise<Response>((_resolve, reject) => {
          failSave = reject;
        });
      return Promise.resolve(
        Response.json(String(url).includes('/conversions?') ? report([]) : { records: [] }),
      );
    }),
  );
  const view = render(<Conversions query={query} ownerToken="owner" />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'new goal or funnel' }));
  fireEvent.change(screen.getByLabelText('Conversion name'), { target: { value: 'Old goal' } });
  fireEvent.submit(screen.getByRole('form'));
  view.rerender(<Conversions query={{ ...query, app_id: 'app-two' }} ownerToken="owner" />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'new goal or funnel' }));
  fireEvent.change(screen.getByLabelText('Conversion name'), { target: { value: 'Current goal' } });
  await act(async () => failSave(new Error('old project save failed')));
  expect(screen.getByLabelText('Conversion name')).toHaveValue('Current goal');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: 'create goal' })).toBeEnabled();
});

it('shows unknown rates and missing property evidence without inventing values', async () => {
  const sparse = report([], {
    goals: [
      {
        id: goal.id,
        name: 'Unmeasured goal',
        occurrences: 0,
        visitors: 0,
        sessions: 0,
        conversion_rate: null,
        value: 0,
      },
    ],
    funnels: [
      {
        id: funnel.id,
        name: 'Unmeasured funnel',
        conversion_rate: null,
        median_conversion_ms: null,
        steps: [],
      },
    ],
    values: [],
    properties: [],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) =>
      Response.json(String(url).includes('/conversions?') ? sparse : { records: [] }),
    ),
  );
  render(<Conversions query={{ ...query, event: 'empty' }} ownerToken="owner" />);
  open();
  expect(await screen.findByRole('heading', { name: 'Unmeasured goal' })).toBeVisible();
  expect(screen.getByText('—')).toBeVisible();
  expect(screen.getByText(/no properties were received/)).toBeVisible();
  expect(screen.queryByText(/median/)).toBeNull();
});

it('keeps a failed segment save available for retry and removes the error after a successful retry', async () => {
  const request = server([]);
  render(
    <SavedSegments
      query={{ ...query, filters: { source: 'Reddit' } }}
      ownerToken="owner"
      onApply={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'saved segments' }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Segment name'), { target: { value: 'Reddit' } });
  request.mockResolvedValueOnce(Response.json({}, { status: 409 }));
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not update saved segments');
  expect(screen.getByLabelText('Segment name')).toHaveValue('Reddit');
  fireEvent.submit(screen.getByRole('form'));
  expect(await screen.findByRole('button', { name: 'Reddit' })).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});
