import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalBrowserAnalytics,
  browserSessionScope,
  projectBrowserBatch,
  queryBrowserSummary,
  type CollectedBrowserBatch,
} from '../src/browser-analytics.js';
import { localBrowserReport } from '../src/browser-reports.js';
import { acceptBrowser, handleBrowserIngest, handleBrowserOwner } from '../src/browser-routes.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import type { AppHealthRepositories } from '../src/repository.js';
import { SEED_APP_ID, SEED_ENV_ID, SEED_PUBLIC_KEY } from '@app-health/contracts';

const batch = (): CollectedBrowserBatch => ({
  workspace: 'workspace-one',
  app_id: 'app-one',
  environment_id: 'env-one',
  batch_id: crypto.randomUUID(),
  received_at: Date.now(),
  events: [
    {
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'pageview',
      path: '/pricing',
      referrer: '',
    },
  ],
  session_hash: 'f'.repeat(64),
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('browser analytical data', () => {
  it('scopes session identifiers without retaining the raw value', async () => {
    const first = await browserSessionScope('app-one', 'env-one', 'session-secret');
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('session-secret');
    expect(await browserSessionScope('app-one', 'env-two', 'session-secret')).not.toBe(first);
  });
  it('counts a retried batch once, separates environments, and expires presence and history', () => {
    vi.useFakeTimers();
    const store = new LocalBrowserAnalytics();
    const input = batch();
    store.ingest(input, 'session');
    store.ingest(input, 'session');
    store.ingest(
      {
        ...input,
        environment_id: 'env-two',
        events: [{ ...input.events[0], type: 'event', name: 'signup' }],
      },
      'session',
    );
    vi.advanceTimersByTime(1);
    expect(store.summary().projects).toEqual([
      { app_id: 'app-one', environment_id: 'env-one', pageviews: 1, events: 0, sessions: 1 },
      { app_id: 'app-one', environment_id: 'env-two', pageviews: 0, events: 1, sessions: 1 },
    ]);
    expect(store.snapshot().total).toBe(2);
    vi.advanceTimersByTime(45000);
    expect(store.snapshot().total).toBe(0);
    store.ingest({ ...input, batch_id: crypto.randomUUID(), events: [] }, 'session');
    expect(store.summary().projects[0].pageviews).toBe(1);
    vi.advanceTimersByTime(86400001);
    expect(store.summary().projects.every((row) => row.pageviews === 0 && row.events === 0)).toBe(
      true,
    );
    store.ingest(batch(), 'new');
    vi.advanceTimersByTime(1);
    expect(store.summary().projects).toHaveLength(1);
  });
  it('deduplicates historical sessions across batches while isolating app and environment scopes', () => {
    const now = Date.now();
    const first = batch();
    first.events = [{ ...first.events[0], timestamp: now - 1_000 }];
    const second = { ...first, batch_id: crypto.randomUUID() };
    const otherEnvironment = { ...first, batch_id: crypto.randomUUID(), environment_id: 'env-two' };
    const otherApp = { ...first, batch_id: crypto.randomUUID(), app_id: 'app-two' };
    expect(localBrowserReport([first, second], { range: '24h' }, now).sessions).toBe(1);
    expect(
      localBrowserReport([first, otherEnvironment, otherApp], { range: '24h' }, now).sessions,
    ).toBe(1);
  });
  it('counts only sessions with activity inside the selected one-hour or day window', () => {
    const now = Date.now();
    const recent = batch();
    recent.events = [{ ...recent.events[0], timestamp: now - 1_000 }];
    const olderBase = batch();
    const older = {
      ...olderBase,
      batch_id: crypto.randomUUID(),
      session_hash: 'e'.repeat(64),
      events: [{ ...olderBase.events[0], timestamp: now - 2 * 3_600_000 }],
    };
    expect(localBrowserReport([recent, older], { range: '1h' }, now).sessions).toBe(1);
    expect(localBrowserReport([recent, older], { range: '24h' }, now).sessions).toBe(2);
  });
  it('queues only the scoped hash and never the raw session identifier', async () => {
    const sent: CollectedBrowserBatch[] = [];
    const response = await acceptBrowser(
      batch(),
      'raw-session-secret',
      {
        BROWSER_EVENTS: { send: async (value) => void sent.push(value) },
        BROWSER_HISTORY: {
          put: async () => ({}) as R2Object,
          list: async () => ({ objects: [], delimitedPrefixes: [], truncated: false }),
          delete: async () => {},
        },
        BROWSER_ARCHIVE: {
          getByName: () => ({
            stage: async () => ({
              accepted: [{ app_id: 'app-one', environment_id: 'env-one', batch_id: 'batch-one' }],
              duplicates: 0,
            }),
          }),
        },
        BROWSER_ANALYTICS: { writeDataPoint: () => {} },
        WORKSPACE_PRESENCE: {
          getByName: () => ({
            heartbeat: async () => {},
            snapshot: async () => ({ measured_at: 0, ttl_ms: 45000, total: 0, projects: [] }),
            fetch: async () => new Response(null, { status: 404 }),
          }),
        },
      },
      {} as AppHealthRepositories,
      false,
    );
    expect(response.status).toBe(202);
    expect(sent[0].session_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(sent[0])).not.toContain('raw-session-secret');
  });
  it('keeps summary and reports in the same half-open event-time window', () => {
    vi.useFakeTimers();
    const store = new LocalBrowserAnalytics();
    const input = batch();
    input.events = [-86_400_001, -1, 0, 60_000].map((offset) => ({
      ...input.events[0],
      event_id: crypto.randomUUID(),
      timestamp: Date.now() + offset,
    }));
    store.ingest(input, 'session');
    expect(store.summary().projects[0].pageviews).toBe(1);
    expect(store.report({ range: '24h' }).series.reduce((sum, row) => sum + row.pageviews, 0)).toBe(
      1,
    );
  });
  it('writes scoped analytical points and surfaces projection failures', () => {
    const writeDataPoint = vi.fn();
    const input = batch();
    projectBrowserBatch(input, { BROWSER_ANALYTICS: { writeDataPoint } });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['workspace-one'],
      blobs: [
        'app-one',
        'env-one',
        'pageview',
        '/pricing',
        '',
        '',
        'f'.repeat(64),
        ...Array(12).fill(''),
      ],
      doubles: [1, input.events[0].timestamp],
    });
    expect(() => projectBrowserBatch(input, {})).toThrow('projection missing');
    writeDataPoint.mockImplementation(() => {
      throw new Error('AE');
    });
    expect(() =>
      projectBrowserBatch(
        { ...input, events: [{ ...input.events[0], type: 'event', name: 'signup' }] },
        { BROWSER_ANALYTICS: { writeDataPoint } },
      ),
    ).toThrow('AE');
  });
  it('uses one bounded, workspace-scoped weighted query and fails on provider errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            app_id: 'app',
            environment_id: 'env',
            pageviews: '24',
            events: 2,
            sessions: 1,
            sample_interval: '10',
          },
        ],
      }),
    );
    const options = { accountId: 'a'.repeat(32), token: 'test', fetchImpl };
    expect(await queryBrowserSummary('workspace-one', options)).toEqual({
      sampled: true,
      projects: [{ app_id: 'app', environment_id: 'env', pageviews: 24, events: 2, sessions: 1 }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.body).toContain("WHERE index1 = 'workspace-one'");
    // Analytics Engine rejects IF branches with Double and Integer types (HTTP 422).
    expect(fetchImpl.mock.calls[0][1]?.body).toContain('double1 * _sample_interval, 0.0)');
    expect(fetchImpl.mock.calls[0][1]?.body).not.toContain('double1 * _sample_interval, 0)');
    expect(fetchImpl.mock.calls[0][1]?.body).toMatch(/AND double2 < \d+ .*GROUP BY/);
    await expect(queryBrowserSummary("x' OR 1=1", options)).rejects.toThrow('scope');
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(queryBrowserSummary('workspace-one', options)).rejects.toThrow('unavailable');
    fetchImpl.mockResolvedValueOnce(Response.json({ data: Array(1001).fill({}) }));
    await expect(queryBrowserSummary('workspace-one', options)).rejects.toThrow('capacity');
  });
});

describe('browser collector boundary', () => {
  async function fixture() {
    const adapter = await InMemoryAdapter.create();
    return adapter.asRepositories();
  }
  const input = () => ({
    schema_version: 1,
    batch_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    public_key: SEED_PUBLIC_KEY,
    events: batch().events,
  });
  const request = (body: unknown, origin = 'http://localhost:5173') =>
    new Request('http://localhost/v1/browser', {
      method: 'POST',
      headers: { origin },
      body: JSON.stringify(body),
    });
  it('accepts only valid origin-bound public keys, counts retries once, and honors revocation', async () => {
    const repos = await fixture();
    const body = input();
    expect(
      (await handleBrowserIngest(request(body, 'https://evil.example'), {}, repos, true))?.status,
    ).toBe(403);
    const result = await handleBrowserIngest(request(body), {}, repos, true);
    expect(result?.status).toBe(202);
    expect(result?.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    await handleBrowserIngest(request(body), {}, repos, true);
    const summary = await handleBrowserOwner(
      new Request('http://localhost/v1/analytics'),
      {},
      { id: 'owner', label: 'test' },
      true,
    );
    expect(await summary?.json()).toMatchObject({
      projects: expect.arrayContaining([
        expect.objectContaining({ app_id: SEED_APP_ID, environment_id: SEED_ENV_ID, pageviews: 1 }),
      ]),
    });
    const key = await repos.publicKeys!.verifyPublicKey(SEED_PUBLIC_KEY);
    await repos.publicKeys!.revokePublicKey(key!.id, Date.now());
    expect((await handleBrowserIngest(request(body), {}, repos, true))?.status).toBe(403);
  });
  it('accepts persistent visitors without exposing raw identities in reports', async () => {
    const repos = await fixture();
    const visitor = crypto.randomUUID();
    const session = crypto.randomUUID();
    const first = {
      ...input(),
      visitor_id: visitor,
      visit_type: 'new',
      session_id: session,
      attribution: {
        source: 'newsletter',
        medium: 'email',
        campaign: 'launch',
        entry_path: '/pricing',
      },
      events: [{ ...batch().events[0], timestamp: Date.now() - 1000 }],
    };
    expect((await handleBrowserIngest(request(first), {}, repos, true))?.status).toBe(202);
    expect(
      (
        await handleBrowserIngest(
          request({
            ...first,
            batch_id: crypto.randomUUID(),
            session_id: crypto.randomUUID(),
            visit_type: 'returning',
          }),
          {},
          repos,
          true,
        )
      )?.status,
    ).toBe(202);
    const response = await handleBrowserOwner(
      new Request(
        `http://localhost/v1/analytics/report?app_id=${SEED_APP_ID}&range=24h&breakdown=acquisition`,
      ),
      {},
      { id: 'owner', label: 'test' },
      true,
    );
    const report = (await response!.json()) as {
      audience: {
        visitors: number;
        new_sessions: number;
        returning_sessions: number;
        campaigns: unknown[];
      };
    };
    expect(report.audience.visitors).toBe(1);
    expect(report.audience.new_sessions).toBe(1);
    expect(report.audience.returning_sessions).toBe(1);
    expect(report.audience.campaigns).toContainEqual({ name: 'launch', count: 2 });
    expect(JSON.stringify(report)).not.toContain(visitor);
    expect(JSON.stringify(report)).not.toContain(session);
  });
  it('rejects identity fields, encoded query data, stale timestamps, invalid JSON and oversized bodies', async () => {
    const repos = await fixture();
    for (const body of [
      { ...input(), user_id: 'private' },
      { ...input(), attribution: { entry_path: '/user%40example.com' } },
      { ...input(), events: [{ ...batch().events[0], path: '/user%40example.com' }] },
      { ...input(), events: [{ ...batch().events[0], timestamp: 0 }] },
      { ...input(), events: Array(26).fill(batch().events[0]) },
    ]) {
      expect((await handleBrowserIngest(request(body), {}, repos, true))?.status).toBe(400);
    }
    expect(
      (
        await handleBrowserIngest(
          new Request('http://localhost/v1/browser', { method: 'POST', body: '{' }),
          {},
          repos,
          true,
        )
      )?.status,
    ).toBe(400);
    expect((await handleBrowserIngest(request('x'.repeat(33000)), {}, repos, true))?.status).toBe(
      413,
    );
    expect(
      await handleBrowserIngest(new Request('http://localhost/unrelated'), {}, repos, true),
    ).toBeNull();
    expect(
      (await handleBrowserIngest(new Request('http://localhost/v1/browser'), {}, repos, true))
        ?.status,
    ).toBe(405);
    expect(
      (
        await handleBrowserIngest(
          new Request('http://localhost/v1/browser', { method: 'OPTIONS' }),
          {},
          repos,
          true,
        )
      )?.status,
    ).toBe(204);
    expect((await handleBrowserIngest(request(input()), {}, repos, false))?.status).toBe(404);
  });
  it('denies non-account production readers and fails closed without bindings', async () => {
    const req = new Request('https://dashboard.example/v1/analytics');
    expect((await handleBrowserOwner(req, {}, { id: 'owner', label: 'test' }, false))?.status).toBe(
      403,
    );
    expect(
      (
        await handleBrowserOwner(
          req,
          {},
          { id: 'owner', label: 'test', appIds: [], workspaceId: 'workspace' },
          false,
        )
      )?.status,
    ).toBe(503);
    expect(
      await handleBrowserOwner(
        new Request('https://dashboard.example/other'),
        {},
        { id: 'owner', label: 'test' },
        false,
      ),
    ).toBeNull();
  });
});
