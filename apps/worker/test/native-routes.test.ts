import { describe, expect, it } from 'vitest';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import { handleNativeIngest, handleNativeKeyOwner } from '../src/native-routes.js';
import { handleBrowserOwner } from '../src/browser-routes.js';

async function fixture() {
  const repos = (await InMemoryAdapter.create()).asRepositories();
  const app = await repos.apps.createApp('Native integration', Date.now());
  const environment = await repos.environments.createEnvironment(app.id, 'prod', Date.now());
  const owner = { id: 'owner', label: 'local', appIds: [app.id] };
  const url = `https://dashboard.test/v1/native-keys?app_id=${app.id}&environment_id=${environment.id}`;
  const manage = (method = 'GET', suffix = '', headers = {}) =>
    handleNativeKeyOwner(new Request(url + suffix, { method, headers }), {}, owner, repos, true);
  const created = (await (await manage('POST'))!.json()) as { key: string; record: { id: string } };
  const input = {
    schema_version: 1,
    public_key: created.key,
    batch_id: crypto.randomUUID(),
    session_id: crypto.randomUUID(),
    active: false,
    events: [
      {
        event_id: crypto.randomUUID(),
        timestamp: Date.now() - 1,
        name: 'swift.canary',
        screen: 'checkout',
      },
    ],
    logs: [
      {
        log_id: crypto.randomUUID(),
        timestamp: Date.now() - 1,
        event: 'swift.canary',
        level: 'info',
        props: { platform: 'swift' },
      },
    ],
  };
  const send = (body: unknown = input, headers = {}) =>
    handleNativeIngest(
      new Request('https://ingest.test/v1/native', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
      {},
      repos,
      true,
    );
  return { repos, app, environment, owner, url, manage, created, input, send };
}
describe('native public collection', () => {
  it('receives explicit native events and logs once on replay, without background presence', async () => {
    const f = await fixture();
    expect((await f.send())?.status).toBe(202);
    expect((await f.send())?.status).toBe(202);
    const logs = await f.repos.logs!.listLogs(f.app.id, f.environment.id, {
      minLevel: 'debug',
      limit: 100,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ source: 'native', props: { platform: 'swift' } });
    const report = await handleBrowserOwner(
      new Request(`https://dashboard.test/v1/analytics/report?range=1h&app_id=${f.app.id}`),
      {},
      f.owner,
      true,
    );
    expect(await report?.json()).toMatchObject({
      events: [expect.objectContaining({ name: 'swift.canary', count: 1 })],
      pages: [],
    });
    const summary = await handleBrowserOwner(
      new Request('https://dashboard.test/v1/analytics'),
      {},
      f.owner,
      true,
    );
    const body = (await summary!.json()) as { live: { projects: { app_id: string }[] } };
    expect(body.live.projects.some((row) => row.app_id === f.app.id)).toBe(false);
    expect((await f.send({ ...f.input, active: true, events: [], logs: [] }))?.status).toBe(202);
    const active = (await (await handleBrowserOwner(
      new Request('https://dashboard.test/v1/analytics'),
      {},
      f.owner,
      true,
    ))!.json()) as { live: { projects: unknown[] } };
    expect(active.live.projects).toContainEqual(
      expect.objectContaining({ app_id: f.app.id, active: 1 }),
    );
    expect((await f.manage('DELETE', `&id=${f.created.record.id}`))?.status).toBe(200);
    expect((await f.send())?.status).toBe(403);
  });
  it('rejects browser origins, invalid or private keys, stale events and oversized bodies', async () => {
    const f = await fixture();
    expect((await f.send(f.input, { origin: 'https://product.test' }))?.status).toBe(403);
    expect((await f.send({ ...f.input, public_key: 'ahk_private' }))?.status).toBe(400);
    expect(
      (await f.send({ ...f.input, events: [{ ...f.input.events[0], timestamp: 0 }] }))?.status,
    ).toBe(400);
    expect(
      (
        await f.send({
          ...f.input,
          events: [{ ...f.input.events[0], name: 'private email@example.com' }],
        })
      )?.status,
    ).toBe(400);
    expect((await f.send('x'.repeat(65537)))?.status).toBe(413);
    expect(
      (
        await handleNativeIngest(
          new Request('https://ingest.test/v1/native', { method: 'POST', body: '{' }),
          {},
          f.repos,
          true,
        )
      )?.status,
    ).toBe(400);
    expect(
      (await handleNativeIngest(new Request('https://ingest.test/v1/native'), {}, f.repos, true))
        ?.status,
    ).toBe(405);
    expect(
      (
        await handleNativeIngest(
          new Request('https://elsewhere.test/v1/native'),
          {},
          f.repos,
          false,
        )
      )?.status,
    ).toBe(404);
  });
  it('isolates key management and fails closed without production storage', async () => {
    const f = await fixture();
    expect((await f.manage('POST', '', { origin: 'https://evil.test' }))?.status).toBe(403);
    expect((await f.manage('PATCH'))?.status).toBe(405);
    expect((await f.manage('DELETE', '&id=missing'))?.status).toBe(404);
    const other = await handleNativeKeyOwner(
      new Request(f.url),
      {},
      { ...f.owner, appIds: [] },
      f.repos,
      true,
    );
    expect(other?.status).toBe(403);
    expect(
      (
        await handleNativeKeyOwner(
          new Request('https://dashboard.test/v1/native-keys'),
          {},
          f.owner,
          f.repos,
          true,
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handleNativeKeyOwner(
          new Request(f.url),
          {},
          { ...f.owner, workspaceId: 'workspace' },
          f.repos,
          false,
        )
      )?.status,
    ).toBe(404);
    const list = (await (await f.manage())!.json()) as { keys: unknown[] };
    expect(list.keys).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(f.created.key);
    for (let i = 0; i < 4; i++) expect((await f.manage('POST'))?.status).toBe(201);
    expect((await f.manage('POST'))?.status).toBe(409);
  });
});
