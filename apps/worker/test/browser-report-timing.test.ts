import { afterEach, expect, it, vi } from 'vitest';
import { withOwnerServerTiming, type OwnerRequestTimings } from '../src/accounts.js';
import { handleBrowserOwner } from '../src/browser-routes.js';

afterEach(() => vi.unstubAllGlobals());

it('reports private fixed-name report stages and preserves cached report behavior', async () => {
  const values = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (request: Request) => values.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      values.set(request.url, response.clone());
    }),
  };
  const provider = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
  vi.stubGlobal('caches', { default: cache });
  vi.stubGlobal('fetch', provider);

  const request = new Request(
    'https://dashboard.example/v1/analytics/report?range=24h&event=filter-secret-marker',
  );
  const env = {
    BROWSER_ANALYTICS: { writeDataPoint: () => {} },
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_ENGINE_QUERY_TOKEN: 'private-token-marker',
  };
  const owner = {
    id: 'owner',
    label: 'Owner',
    workspaceId: 'workspace-secret-marker',
    appIds: ['app-secret-marker'],
  };

  const firstTimings: OwnerRequestTimings = {};
  const first = await handleBrowserOwner(request, env, owner, false, firstTimings);
  expect(first?.status).toBe(200);
  const firstTimed = withOwnerServerTiming(first!, firstTimings);
  const firstTiming = firstTimed.headers.get('server-timing') ?? '';
  for (const stage of [
    'analytics_cache_lookup',
    'analytics_query_wait',
    'analytics_trend',
    'analytics_pages',
    'analytics_sources',
    'analytics_events',
    'analytics_audience_previous',
    'analytics_dimension_max',
    'analytics_report_assembly',
    'route_read',
  ])
    expect(firstTiming).toMatch(new RegExp(`(?:^|, )${stage};dur=\\d+\\.\\d{2}(?:, |$)`));
  expect(firstTiming).not.toContain('analytics_engagement');
  expect(firstTiming).not.toContain('analytics_exits');
  for (const secret of [
    'filter-secret-marker',
    'private-token-marker',
    'workspace-secret-marker',
    'app-secret-marker',
  ])
    expect(firstTiming).not.toContain(secret);
  const firstBody = await firstTimed.json();
  expect(firstBody).toMatchObject({ source: 'analytics-engine', sampled: false, sessions: 0 });
  expect(provider).toHaveBeenCalled();

  const queryCount = provider.mock.calls.length;
  const secondTimings: OwnerRequestTimings = {};
  const second = await handleBrowserOwner(request, env, owner, false, secondTimings);
  expect(second?.status).toBe(200);
  const secondTimed = withOwnerServerTiming(second!, secondTimings);
  expect(secondTimed.headers.get('server-timing')).toMatch(
    /^analytics_cache_lookup;dur=\d+\.\d{2}, route_read;dur=\d+\.\d{2}$/,
  );
  await expect(secondTimed.json()).resolves.toEqual(firstBody);
  expect(provider).toHaveBeenCalledTimes(queryCount);
  expect(cache.match).toHaveBeenCalledTimes(2);

  const unfilteredTimings: OwnerRequestTimings = {};
  const unfiltered = await handleBrowserOwner(
    new Request('https://dashboard.example/v1/analytics/report?range=24h'),
    env,
    owner,
    false,
    unfilteredTimings,
  );
  expect(unfiltered?.status).toBe(200);
  const unfilteredHeader = withOwnerServerTiming(unfiltered!, unfilteredTimings).headers.get(
    'server-timing',
  );
  expect(unfilteredHeader).toContain('analytics_engagement;dur=');
  expect(unfilteredHeader).toContain('analytics_exits;dur=');
});

it('separates private summary provider, cache and presence work on cold and warm reads', async () => {
  const values = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      match: async (request: Request) => values.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        values.set(request.url, response.clone());
      },
    },
  });
  const provider = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal('fetch', provider);
  const snapshot = vi.fn(async () => ({
    measured_at: Date.now(),
    ttl_ms: 45000,
    total: 0,
    projects: [],
  }));
  const env = {
    BROWSER_EVENTS: { send: async () => {} },
    WORKSPACE_PRESENCE: { getByName: () => ({ snapshot }) },
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    ANALYTICS_ENGINE_QUERY_TOKEN: 'private-query-token',
  };
  const owner = { id: 'owner', label: 'Owner', workspaceId: 'workspace', appIds: [] };
  for (const cold of [true, false]) {
    const timings: OwnerRequestTimings = {};
    const response = await handleBrowserOwner(
      new Request('https://dashboard.example/v1/analytics'),
      env as never,
      owner,
      false,
      timings,
    );
    expect(response?.status).toBe(200);
    const header = withOwnerServerTiming(response!, timings).headers.get('server-timing')!;
    for (const name of [
      'analytics_cache_lookup',
      'analytics_summary',
      'analytics_presence',
      'route_read',
    ])
      expect(header).toContain(`${name};dur=`);
    expect(header.includes('analytics_summary_provider;dur=')).toBe(cold);
    expect(header).not.toMatch(/private-query-token|workspace/);
  }
  expect(provider).toHaveBeenCalledOnce();
  expect(snapshot).toHaveBeenCalledTimes(2);
});

it.each(['provider', 'presence'])(
  'retains summary failure behavior while measuring the failed %s boundary',
  async (failure) => {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => {} } });
    vi.stubGlobal('fetch', async () =>
      failure === 'provider' ? new Response(null, { status: 503 }) : Response.json({ data: [] }),
    );
    const env = {
      BROWSER_EVENTS: { send: async () => {} },
      WORKSPACE_PRESENCE: {
        getByName: () => ({
          snapshot: async () => {
            if (failure === 'presence') throw new Error('unavailable');
            return { measured_at: Date.now(), ttl_ms: 45000, total: 0, projects: [] };
          },
        }),
      },
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      ANALYTICS_ENGINE_QUERY_TOKEN: 'private-query-token',
    };
    const timings: OwnerRequestTimings = {};
    const response = await handleBrowserOwner(
      new Request('https://dashboard.example/v1/analytics'),
      env as never,
      { id: 'owner', label: 'Owner', workspaceId: 'workspace', appIds: [] },
      false,
      timings,
    );
    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({
      error: 'Browser analytics is temporarily unavailable.',
    });
    expect(
      timings[failure === 'provider' ? 'analyticsSummaryProviderMs' : 'analyticsPresenceMs'],
    ).toBeTypeOf('number');
  },
);
