import { afterEach, expect, it, vi } from 'vitest';
import { SEED_KEY } from '@app-health/contracts';
import worker from '../src/index.js';
import { monitorSelfRequest } from '../src/self-backend.js';

const env = {
  APP_HEALTH_SELF_BACKEND_KEY: SEED_KEY,
  APP_HEALTH_DASHBOARD_HOST: 'dashboard.example.com',
  APP_HEALTH_INGEST_HOST: 'ingest.example.com',
  APP_HEALTH_INGEST_ORIGIN: 'https://ingest.example.com',
};
const request = (path = '/v1/endpoints', method = 'GET') =>
  new Request(`https://dashboard.example.com${path}`, { method });
function context() {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil: (p: Promise<unknown>) => pending.push(p) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('delivers actual SDK batches through authenticated collector without recursion', async () => {
  const ctx = context();
  const payloads: string[] = [];
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    payloads.push(String(init.body));
    const response = await worker.fetch(
      new Request(url, init),
      { ...env, APP_HEALTH_MODE: 'local' },
      ctx,
    );
    expect(response.status).toBe(202);
    return response;
  });
  vi.stubGlobal('fetch', transport);
  const response = await worker.fetch(
    request('/v1/health?secret=private'),
    { ...env, APP_HEALTH_MODE: 'local' },
    ctx,
  );
  expect(response.status).toBe(200);
  await Promise.all(ctx.pending);
  expect(transport).toHaveBeenCalledTimes(1);
  const batch = JSON.parse(payloads[0]);
  expect(batch.events).toHaveLength(1);
  expect(batch.events[0]).toMatchObject({ method: 'GET', route: '/v1/health', status_code: 200 });
  expect(payloads[0]).not.toContain('private');
  expect(batch.events[0].duration_ms).toBeGreaterThanOrEqual(0);
});

it('returns immediately while delivery is pending and preserves response identity', async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const ctx = context();
  const response = new Response('streamed response', { status: 201 });
  expect(await monitorSelfRequest(request(), env, ctx, async () => response)).toBe(response);
  expect(ctx.pending).toHaveLength(1);
  complete(new Response(null, { status: 202 }));
  await Promise.all(ctx.pending);
});

it('measures slow failures without changing the thrown error or leaking request values', async () => {
  const batches: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      batches.push(JSON.parse(init.body));
      return new Response(null, { status: 202 });
    }),
  );
  vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(450);
  const ctx = context();
  const error = new Error('private failure');
  const req = new Request(
    'https://dashboard.example.com/v1/apps/private-app/environments/private-env/keys?token=private',
    {
      method: 'POST',
      headers: { authorization: 'private-auth', cookie: 'private-cookie' },
      body: 'private-body',
    },
  );
  await expect(
    monitorSelfRequest(req, env, ctx, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  await Promise.all(ctx.pending);
  expect(batches).toEqual([
    expect.objectContaining({
      events: [
        expect.objectContaining({
          route: '/v1/apps/:appId/environments/:environmentId/keys',
          status_code: 500,
          duration_ms: 350,
        }),
      ],
    }),
  ]);
  expect(JSON.stringify(batches)).not.toContain('private');
});

it.each([
  ['/v1/ingest', 'POST'],
  ['/v1/traces', 'POST'],
  ['/v1/browser', 'POST'],
  ['/v1/native', 'POST'],
  ['/v1/logs', 'POST'],
  ['/v1/analytics/live', 'GET'],
  ['/v1/unknown/private', 'GET'],
  ['/assets/main.js', 'GET'],
  ['/v1/endpoints', 'OPTIONS'],
])('excludes %s %s', async (path, method) => {
  const transport = vi.fn();
  vi.stubGlobal('fetch', transport);
  const ctx = context();
  await monitorSelfRequest(request(path, method), env, ctx, async () => new Response());
  expect(ctx.pending).toHaveLength(0);
  expect(transport).not.toHaveBeenCalled();
});

it.each([
  {},
  { ...env, APP_HEALTH_SELF_BACKEND_KEY: '' },
  { ...env, APP_HEALTH_INGEST_ORIGIN: 'http://ingest.example.com' },
  { ...env, APP_HEALTH_INGEST_ORIGIN: 'https://wrong.example.com' },
  { ...env, APP_HEALTH_INGEST_ORIGIN: 'https://private@ingest.example.com' },
  { ...env, APP_HEALTH_INGEST_ORIGIN: 'invalid' },
])('fails open for missing or invalid configuration', async (bindings) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const transport = vi.fn();
  vi.stubGlobal('fetch', transport);
  const response = new Response('ok');
  const ctx = context();
  expect(await monitorSelfRequest(request(), bindings, ctx, async () => response)).toBe(response);
  expect(transport).not.toHaveBeenCalled();
});

it('skips foreign hosts, upgrades and absent execution context', async () => {
  const ctx = context();
  for (const req of [
    new Request('https://ingest.example.com/v1/health'),
    new Request(request(), { headers: { upgrade: 'websocket' } }),
  ])
    await monitorSelfRequest(req, env, ctx, async () => new Response());
  await monitorSelfRequest(request(), env, undefined, async () => new Response());
  expect(ctx.pending).toHaveLength(0);
});

it('normalizes dynamic routes and isolates concurrent delivery batches', async () => {
  const bodies: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      bodies.push(init.body);
      return new Response(null, { status: 202 });
    }),
  );
  const ctx = context();
  await Promise.all(
    [
      ['/v1/apps/one/environments', '/v1/apps/:appId/environments'],
      [
        '/v1/apps/one/environments/two/revoke',
        '/v1/apps/:appId/environments/:environmentId/revoke',
      ],
      ['/v1/public-keys/three/revoke', '/v1/public-keys/:keyId/revoke'],
      ['/v1/auth/callback/google', '/v1/auth/callback/:provider'],
      ['/v1/logs', '/v1/logs'],
    ].map(async ([path, route]) => {
      const local = context();
      await monitorSelfRequest(request(path), env, local, async () => new Response());
      ctx.pending.push(...local.pending);
      await Promise.all(local.pending);
      expect(bodies.some((body) => JSON.parse(body).events[0].route === route)).toBe(true);
    }),
  );
  await Promise.all(ctx.pending);
  expect(bodies).toHaveLength(5);
  expect(new Set(bodies.map((body) => JSON.parse(body).batch_id)).size).toBe(5);
});

it('handles rejected keys and unexpected delivery failures without exposing errors', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  const ctx = context();
  expect(
    (await monitorSelfRequest(request(), env, ctx, async () => new Response('ok'))).status,
  ).toBe(200);
  await Promise.all(ctx.pending);
  expect(warning).toHaveBeenCalledWith('{"event":"self_backend_delivery_failed"}');
  expect(fetch).toHaveBeenCalledTimes(1);
});
