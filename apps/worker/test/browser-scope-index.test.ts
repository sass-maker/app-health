import { describe, expect, it, vi } from 'vitest';
import { browserScopeIndexOwnerRoute } from '../src/browser-scope-index.js';
import { ownerRouteAllowed } from '../src/access-policy.js';
import type { OwnerIdentity } from '../src/identity.js';
import type { BrowserEnvironment } from '../src/browser-routes.js';

const owner: OwnerIdentity = {
  id: 'owner',
  label: 'Owner',
  authKind: 'account',
  workspaceRole: 'owner',
  workspaceId: 'workspace-one',
};
const url = 'https://health.test/v1/browser/archive-scope-index';
const valid = { day: '2026-11-03', shard: 15 };
function harness() {
  const repair = vi.fn(async () => ({
    checked: 3,
    indexed: 3,
    next_cursor: null,
    snapshot_sequence: 10,
    complete: false,
    note: 'Metadata only.',
  }));
  const getByName = vi.fn(() => ({ reindexScopeSegments: repair }));
  const env = { BROWSER_ARCHIVE: { getByName } } as unknown as BrowserEnvironment;
  const request = (body: unknown = valid, init: RequestInit = {}) =>
    new Request(url, {
      method: 'POST',
      headers: { origin: 'https://health.test' },
      body: JSON.stringify(body),
      ...init,
    });
  return { repair, getByName, env, request };
}

describe('archive scope index operator boundary', () => {
  it('routes only server-selected workspace and shard and keeps responses private', async () => {
    const h = harness();
    const response = (await browserScopeIndexOwnerRoute(h.request(), h.env, owner, false))!;
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.getByName).toHaveBeenCalledWith('workspace-one:browser-archive-v1:15');
    expect(h.repair).toHaveBeenCalledWith('2026-11-03', null, 'workspace-one');
    expect(await response.json()).toMatchObject({ complete: false, checked: 3, indexed: 3 });
  });

  it.each([
    { ...owner, authKind: 'api-token' as const, apiPermission: 'manage' as const },
    { ...owner, workspaceRole: 'editor' as const },
    { ...owner, workspaceRole: 'viewer' as const },
    { ...owner, appId: 'app-one' },
    { ...owner, workspaceId: undefined },
  ])('rejects restricted identities before selecting a shard', async (identity) => {
    const h = harness();
    expect((await browserScopeIndexOwnerRoute(h.request(), h.env, identity, false))!.status).toBe(
      403,
    );
    expect(h.getByName).not.toHaveBeenCalled();
    if (identity.authKind === 'api-token' || identity.workspaceRole !== 'owner')
      expect(ownerRouteAllowed(h.request(), identity)).toBe(false);
  });

  it('enforces method, same origin, production identity, and bounded JSON before I/O', async () => {
    const h = harness();
    for (const [request, local, status] of [
      [new Request(url), false, 405],
      [h.request(valid, { headers: { origin: 'https://foreign.test' } }), false, 403],
      [h.request(valid, { headers: {} }), false, 403],
      [h.request(), true, 403],
      [h.request(valid, { body: 'x'.repeat(16385) }), false, 413],
      [h.request(valid, { body: '{' }), false, 400],
      [
        h.request(valid, { headers: { origin: 'https://health.test', 'content-length': '16385' } }),
        false,
        413,
      ],
      [
        new Request(`${url}?day=2026-11-03`, {
          method: 'POST',
          headers: { origin: 'https://health.test' },
          body: JSON.stringify(valid),
        }),
        false,
        400,
      ],
    ] as const) {
      expect((await browserScopeIndexOwnerRoute(request, h.env, owner, local))!.status).toBe(
        status,
      );
    }
    expect(h.getByName).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [],
    { ...valid, workspace: 'foreign' },
    { ...valid, app_id: 'app-one' },
    { ...valid, limit: 100 },
    { ...valid, day: '2026-02-30' },
    { ...valid, shard: -1 },
    { ...valid, shard: 16 },
    { ...valid, shard: '0' },
    { ...valid, cursor: { event_day: '2026-11-02', object_key: 'x', snapshot_sequence: 10 } },
    { ...valid, cursor: { event_day: valid.day, object_key: '', snapshot_sequence: 10 } },
    { ...valid, cursor: { event_day: valid.day, object_key: 'x', snapshot_sequence: -1 } },
    {
      ...valid,
      cursor: { event_day: valid.day, object_key: 'x', snapshot_sequence: 10, limit: 100 },
    },
  ])('rejects invalid or caller-expanded work: %j', async (body) => {
    const h = harness();
    expect((await browserScopeIndexOwnerRoute(h.request(body), h.env, owner, false))!.status).toBe(
      400,
    );
    expect(h.getByName).not.toHaveBeenCalled();
  });

  it('passes a valid cursor and hides unavailable binding and raw errors', async () => {
    const h = harness();
    const cursor = { event_day: valid.day, object_key: 'browser-v2/key', snapshot_sequence: 10 };
    expect(
      (await browserScopeIndexOwnerRoute(h.request({ ...valid, cursor }), h.env, owner, false))!
        .status,
    ).toBe(200);
    expect(h.repair).toHaveBeenLastCalledWith(valid.day, cursor, 'workspace-one');
    h.repair.mockRejectedValueOnce(new Error('private object and SQL diagnostics'));
    const failure = (await browserScopeIndexOwnerRoute(h.request(), h.env, owner, false))!;
    expect(failure.status).toBe(503);
    expect(JSON.stringify(await failure.json())).not.toContain('private');
    expect((await browserScopeIndexOwnerRoute(h.request(), {}, owner, false))!.status).toBe(503);
  });
});
