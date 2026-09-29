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
    'analytics_audience',
    'analytics_dimension_max',
    'analytics_previous',
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
