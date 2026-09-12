import { describe, expect, it } from 'vitest';
import { InMemoryAdapter, AppHealthService } from '../src/index.js';
import { handleProjectRoutes } from '../src/project-routes.js';
import { handleBrowserIngest } from '../src/browser-routes.js';
import { BearerOwnerIdentityAdapter } from '../src/identity.js';
import { EnvironmentCapabilities, EnvironmentKeyResponse } from '@app-health/contracts';

async function fixture() {
  const repos = (await InMemoryAdapter.create()).asRepositories();
  const service = new AppHealthService(repos);
  const created = await service.createApp(
    { name: 'Scoped product', environment: 'production', key_scope: 'environment' },
    Date.now(),
  );
  const owner = { id: 'alice', label: 'Alice', appIds: [created.app.id] };
  const path = `/v1/capabilities?app_id=${created.app.id}&environment_id=${created.environment.id}`;
  const call = (url: string, method = 'GET', input?: unknown, identity = owner) =>
    handleProjectRoutes(
      new Request(`http://local${url}`, {
        method,
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      repos,
      identity,
    );
  return { repos, service, created, call, path };
}
const endpointBatch = (environment = 'production') => ({
  schema_version: 'v1',
  batch_id: crypto.randomUUID(),
  runtime: 'node',
  environment,
  events: [
    {
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      method: 'GET',
      route: '/health',
      status_code: 200,
      duration_ms: 8,
    },
  ],
});

describe('independent environment capability foundation', () => {
  it('keeps simultaneous independent receipts and preference updates without lost state', async () => {
    const f = await fixture();
    await Promise.all([
      f.repos.capabilities!.recordCapability(
        f.created.app.id,
        f.created.environment.id,
        'analytics',
        10,
      ),
      f.repos.capabilities!.recordCapability(
        f.created.app.id,
        f.created.environment.id,
        'logs',
        11,
      ),
      f.repos.capabilities!.recordCapability(
        f.created.app.id,
        f.created.environment.id,
        'endpoints',
        12,
      ),
    ]);
    const rows = await f.repos.capabilities!.getCapabilities(
      f.created.app.id,
      f.created.environment.id,
    );
    expect(rows.map((row) => row.first_received_at)).toEqual([10, 12, 11]);
    expect(rows.every((row) => row.enabled)).toBe(true);
    await Promise.all([
      f.repos.capabilities!.setCapabilities(f.created.app.id, f.created.environment.id, []),
      f.repos.capabilities!.recordCapability(
        f.created.app.id,
        f.created.environment.id,
        'analytics',
        20,
      ),
    ]);
    const latest = await f.repos.capabilities!.getCapabilities(
      f.created.app.id,
      f.created.environment.id,
    );
    expect(latest[0]).toMatchObject({
      enabled: false,
      first_received_at: 10,
      last_received_at: 20,
    });
    expect(latest[2].first_received_at).toBe(11);
  });

  it('starts setup independently, scopes new keys, and denies ingestion-key administration', async () => {
    const f = await fixture();
    expect(f.created.key.environment_id).toBe(f.created.environment.id);
    const state = EnvironmentCapabilities.parse(await (await f.call(f.path))!.json());
    expect(state.capabilities.every((c) => !c.enabled && c.first_received_at === null)).toBe(true);
    expect(JSON.stringify(state)).not.toContain('verifier_hash');
    expect(JSON.stringify(state)).not.toContain(f.created.key.key);
    const auth = new BearerOwnerIdentityAdapter('owner-only', f.repos.keys);
    expect(
      await auth.resolve(
        new Request('http://local', { headers: { authorization: `Bearer ${f.created.key.key}` } }),
      ),
    ).toBeNull();
    expect(
      (await f.call(f.path, 'GET', undefined, { id: 'bob', label: 'Bob', appIds: [] }))?.status,
    ).toBe(403);
    expect(
      (
        await f.call(
          `/v1/apps/${f.created.app.id}/environments`,
          'POST',
          { name: 'staging' },
          { id: 'bob', label: 'Bob', appIds: [] },
        )
      )?.status,
    ).toBe(403);
  });

  it('only accepts the matching private environment and preserves receipt outside query windows', async () => {
    const f = await fixture();
    const now = Date.now();
    expect((await f.service.ingest(f.created.key.key, endpointBatch('staging'), now)).ok).toBe(
      false,
    );
    expect(
      (await f.repos.capabilities!.getCapabilities(f.created.app.id, f.created.environment.id))[1]
        .first_received_at,
    ).toBeNull();
    expect((await f.service.ingest(f.created.key.key, endpointBatch(), now)).ok).toBe(true);
    const rows = await f.repos.capabilities!.getCapabilities(
      f.created.app.id,
      f.created.environment.id,
    );
    expect(rows.find((c) => c.id === 'endpoints')).toMatchObject({
      enabled: true,
      first_received_at: now,
      last_received_at: now,
    });
    expect(rows.find((c) => c.id === 'analytics')!.first_received_at).toBeNull();
    expect(
      (
        await f.service.queryEndpoints(
          f.created.app.id,
          f.created.environment.id,
          '15m',
          now + 86_400_000,
        )
      ).endpoints.every((e) => !e.metrics_available),
    ).toBe(true);
    await f.call(f.path, 'PUT', { enabled: ['logs'] });
    const quiet = EnvironmentCapabilities.parse(await (await f.call(f.path))!.json());
    expect(quiet.capabilities.find((c) => c.id === 'endpoints')).toMatchObject({
      enabled: false,
      first_received_at: now,
    });
  });

  it('adds isolated environments and rotates only their private keys', async () => {
    const f = await fixture();
    const path = `/v1/apps/${f.created.app.id}/environments`;
    const response = await f.call(path, 'POST', { name: 'staging' });
    expect(response?.status).toBe(201);
    const staging = EnvironmentKeyResponse.parse(await response!.json());
    expect(staging.key.environment_id).toBe(staging.environment.id);
    expect((await f.call(path, 'POST', { name: 'staging' }))?.status).toBe(409);
    expect((await f.call(path, 'POST', { name: 'not valid!' }))?.status).toBe(400);
    const rotated = EnvironmentKeyResponse.parse(
      await (await f.call(`${path}/${staging.environment.id}/keys`, 'POST'))!.json(),
    );
    expect(await f.repos.keys.verifyKey(staging.key.key)).toBeNull();
    expect(await f.repos.keys.verifyKey(rotated.key.key)).not.toBeNull();
    expect(await f.repos.keys.verifyKey(f.created.key.key)).not.toBeNull();
    expect((await f.call(`${path}/missing/keys`, 'POST'))?.status).toBe(404);
  });

  it('activates browser analytics only after valid accepted events, not heartbeat or rejected Origin', async () => {
    const f = await fixture();
    const key = await f.service.createPublicKey(
      {
        app_id: f.created.app.id,
        environment_id: f.created.environment.id,
        allowed_origins: ['https://product.example'],
      },
      Date.now(),
    );
    const send = (events: unknown[], origin = 'https://product.example') =>
      handleBrowserIngest(
        new Request('http://local/v1/browser', {
          method: 'POST',
          headers: { origin },
          body: JSON.stringify({
            schema_version: 1,
            batch_id: crypto.randomUUID(),
            session_id: crypto.randomUUID(),
            public_key: key!.key,
            events,
          }),
        }),
        {},
        f.repos,
        true,
      );
    const event = {
      event_id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'pageview',
      path: '/',
      referrer: '',
    };
    expect((await send([]))?.status).toBe(202);
    expect((await send([event], 'https://foreign.example'))?.status).toBe(403);
    expect(
      (await f.repos.capabilities!.getCapabilities(f.created.app.id, f.created.environment.id))[0]
        .first_received_at,
    ).toBeNull();
    expect((await send([event]))?.status).toBe(202);
    expect(
      (await f.repos.capabilities!.getCapabilities(f.created.app.id, f.created.environment.id))[0],
    ).toMatchObject({ enabled: true, first_received_at: expect.any(Number) });
  });

  it('explicit logs activate logs alone, and malformed requests cannot change choices', async () => {
    const f = await fixture();
    const log = {
      log_id: crypto.randomUUID(),
      timestamp: Date.now(),
      event: 'review.completed',
      level: 'info',
      props: {},
    };
    const result = await f.service.ingestLogs(
      f.created.key.key,
      { schema_version: 'v1', logs: [log] },
      Date.now(),
    );
    expect(result.ok).toBe(true);
    const rows = await f.repos.capabilities!.getCapabilities(
      f.created.app.id,
      f.created.environment.id,
    );
    expect(rows.filter((c) => c.first_received_at !== null).map((c) => c.id)).toEqual(['logs']);
    expect((await f.call(f.path, 'PUT', { enabled: ['unknown'] }))?.status).toBe(400);
    expect((await f.call(f.path, 'DELETE'))?.status).toBe(405);
    expect((await f.call('/v1/capabilities'))?.status).toBe(400);
    expect((await f.call(f.path.replace(f.created.environment.id, 'missing')))?.status).toBe(404);
  });
});
