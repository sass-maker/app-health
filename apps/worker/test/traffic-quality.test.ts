import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBrowserOwner, type BrowserEnvironment } from '../src/browser-routes.js';
import { queryTrafficQuality } from '../src/traffic-quality.js';
import { ownerRouteAllowed } from '../src/access-policy.js';
import type { OwnerIdentity } from '../src/identity.js';

const now = 1_800_000_000_000;
const scope = { app_id: 'app-one', environment_id: 'env-one', from: now - 86_400_000, to: now };
const owner: OwnerIdentity = {
  id: 'owner',
  label: 'Owner',
  workspaceId: 'workspace-one',
  appIds: ['app-one'],
};
const env = {
  BROWSER_ANALYTICS: { writeDataPoint: vi.fn() },
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  ANALYTICS_ENGINE_QUERY_TOKEN: 'fixture',
} satisfies BrowserEnvironment;
const url = (patch = {}) =>
  `https://app.test/v1/analytics/traffic-quality?${new URLSearchParams(Object.entries({ ...scope, ...patch }).map(([key, value]) => [key, String(value)]))}`;
const request = (patch = {}) => new Request(url(patch));
const read = (patch = {}, identity = owner, local = false, bindings = env) =>
  handleBrowserOwner(request(patch), bindings, identity, local);
function queryRows(data: unknown) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data }));
  return {
    fetchImpl,
    run: () =>
      queryTrafficQuality(scope, { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl }),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('traffic quality owner route', () => {
  it('denies projects outside the resolved workspace and exact token app/environment scopes before querying', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(
      (await read({}, { ...owner, workspaceId: 'other-workspace', appIds: ['other-app'] }))?.status,
    ).toBe(403);
    const token = {
      ...owner,
      authKind: 'api-token' as const,
      apiPermission: 'read' as const,
      apiScopes: [{ app_id: 'app-one', environment_id: 'env-one' }],
    };
    expect((await read({ environment_id: 'other-env' }, token))?.status).toBe(403);
    expect((await read({ app_id: 'other-app' }, token))?.status).toBe(403);
    expect(ownerRouteAllowed(request(), token)).toBe(true);
    expect(ownerRouteAllowed(request({ environment_id: 'other-env' }), token)).toBe(false);
    expect(
      ownerRouteAllowed(
        new Request(url(), { headers: { 'x-app-health-workspace': 'other-workspace' } }),
        token,
      ),
    ).toBe(false);
    expect(ownerRouteAllowed(request(), { ...owner, workspaceRole: 'viewer' })).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires authentication workspace scope and GET', async () => {
    expect((await read({}, { id: 'legacy', label: 'Legacy' }))?.status).toBe(403);
    expect(
      (await handleBrowserOwner(new Request(url(), { method: 'POST' }), env, owner, false))?.status,
    ).toBe(405);
  });
  it.each([
    { from: now, to: now },
    { from: now, to: now - 1 },
    { to: now + 1 },
    { from: now - 31 * 86_400_000 },
    { from: now - 91 * 86_400_000, to: now - 90 * 86_400_000 },
    { from: '' },
    { from: 'NaN' },
    { to: 'Infinity' },
    { app_id: '' },
    { environment_id: '' },
    { source: 'Google' },
    { event: 'signup' },
    { path: '/pricing' },
  ])('rejects invalid or unsupported query %s', async (patch) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect((await read(patch))?.status).toBe(400);
  });
  it('rejects duplicate query keys and missing bounds', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const target of [url() + '&app_id=app-one', url().replace(`&to=${now}`, '')])
      expect((await handleBrowserOwner(new Request(target), env, owner, false))?.status).toBe(400);
  });
  it('returns unknown for local, unavailable and oversized counter indexes without provider requests', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect(await (await read({}, owner, true))?.json()).toMatchObject({
      ...scope,
      time_basis: 'receipt_time',
      qa_internal: 'not_separately_identified',
      bots: { status: 'unknown', reason: 'local' },
    });
    expect(await (await read({}, owner, false, {} as typeof env))?.json()).toMatchObject({
      bots: { status: 'unknown', reason: 'unavailable' },
    });
    const app_id = 'a'.repeat(93);
    expect(await (await read({ app_id }, { ...owner, appIds: [app_id] }))?.json()).toMatchObject({
      bots: { status: 'unknown', reason: 'index_too_long' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns an authorized 30-day observation with the exact captured interval', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ data: [{ bot_class: 'verified', pageviews: 3, sample_interval: 1 }] }),
    );
    const from = now - 30 * 86_400_000;
    const response = await read({ from });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      ...scope,
      from,
      generated_at: now,
      bots: {
        status: 'observed',
        pageview_attempts: 3,
        cloudflare_verified: 3,
        recognized_user_agent: 0,
        estimated: false,
        coverage: 'partial',
      },
    });
  });
  it('isolates upstream transport failure as unknown with no-store', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const response = await read();
    expect(response?.status).toBe(200);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toMatchObject({
      bots: { status: 'unknown', reason: 'unavailable' },
    });
  });
});

describe('retained bot query', () => {
  it('aggregates detector classes using sampled receipt-time counters within exact app/environment scope', async () => {
    const fixture = queryRows([
      { bot_class: 'verified', pageviews: '8', sample_interval: '2' },
      { bot_class: 'user_agent', pageviews: 3, sample_interval: 1 },
    ]);
    expect(await fixture.run()).toEqual({
      status: 'observed',
      pageview_attempts: 11,
      cloudflare_verified: 8,
      recognized_user_agent: 3,
      estimated: true,
      coverage: 'partial',
    });
    const sql = fixture.fetchImpl.mock.calls[0][1]?.body;
    for (const fragment of [
      "index1 = 'bot:app-one'",
      "blob1 = 'app-one'",
      "blob2 = 'env-one'",
      "blob3 = 'bot_batch'",
      'blob5 AS bot_class',
      'SUM(double1 * _sample_interval)',
      `double2 >= ${scope.from}`,
      `double2 < ${scope.to}`,
      'LIMIT 3',
    ])
      expect(sql).toContain(fragment);
    expect(sql).not.toContain('heartbeat');
  });
  it('does not treat empty or zero aggregates as proof of counted zero bots', async () => {
    for (const rows of [[], [{ bot_class: 'verified', pageviews: 0, sample_interval: 1 }]])
      expect(await queryRows(rows).run()).toEqual({ status: 'unknown', reason: 'no_records' });
  });
  it.each([
    [{ bot_class: 'other', pageviews: 1, sample_interval: 1 }],
    [{ bot_class: 'verified', pageviews: null, sample_interval: 1 }],
    [{ bot_class: 'verified', pageviews: true, sample_interval: 1 }],
    [{ bot_class: 'verified', pageviews: '', sample_interval: 1 }],
    [{ bot_class: 'verified', pageviews: -1, sample_interval: 1 }],
    [{ bot_class: 'verified', pageviews: 1, sample_interval: 0 }],
    [
      { bot_class: 'verified', pageviews: 1, sample_interval: 1 },
      { bot_class: 'verified', pageviews: 2, sample_interval: 1 },
    ],
  ])('does not turn malformed counters into positive or zero claims %s', async (...rows) => {
    expect(await queryRows(rows).run()).toEqual({ status: 'unknown', reason: 'invalid_response' });
  });
  it('rejects aggregate overflow and provider failure', async () => {
    expect(
      await queryRows([
        { bot_class: 'verified', pageviews: Number.MAX_SAFE_INTEGER, sample_interval: 1 },
        { bot_class: 'user_agent', pageviews: 1, sample_interval: 1 },
      ]).run(),
    ).toMatchObject({ status: 'unknown' });
    expect(
      await queryTrafficQuality(scope, {
        accountId: 'a'.repeat(32),
        token: 'fixture',
        fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
      }),
    ).toEqual({ status: 'unknown', reason: 'unavailable' });
  });
});
