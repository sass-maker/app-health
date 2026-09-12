import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { makeSignature } from 'better-auth/crypto';
import { createAccountAuth, personalWorkspace, accountMutationAllowed } from '../src/accounts.js';
import worker, { type Env } from '../src/index.js';
import { D1ControlPlane } from '../src/d1-adapter.js';

describe('Google account boundary with real D1 SQL', () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  let env: Env;
  let aliceCookie: string;
  let bobCookie: string;
  let aliceApp: { app: { id: string }; environment: { id: string } };
  beforeAll(async () => {
    const db = await mf.getD1Database('DB');
    for (const file of [
      '0001_v0_initial.sql',
      '0002_observed_endpoint_inventory.sql',
      '0003_batch_dedupe.sql',
      '0004_product_keys.sql',
      '0005_log_events.sql',
      '0006_browser_logs.sql',
      '0007_accounts.sql',
      '0008_environment_capabilities.sql',
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const statement of sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((s) => s.trim()))
        await db.prepare(statement).run();
    }
    env = {
      DB: db,
      APP_HEALTH_ACCOUNTS: 'enabled',
      APP_HEALTH_DASHBOARD_HOST: 'dashboard.example.com',
      APP_HEALTH_INGEST_HOST: 'ingest.example.com',
      APP_HEALTH_INGEST_ORIGIN: 'https://ingest.example.com',
      GOOGLE_CLIENT_ID: 'test-google-client',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
      BETTER_AUTH_SECRET: 'synthetic-test-auth-secret-at-least-32-characters',
      OWNER_AUTH_TOKEN: 'synthetic-owner',
      CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic-query',
      TELEMETRY: { writeDataPoint() {} },
    };
    const auth = createAccountAuth(env)!;
    const ctx = await auth.$context;
    async function cookie(name: string) {
      const user = await ctx.internalAdapter.createUser(
        { name, email: `${name}@example.com`, emailVerified: true },
        { method: 'oauth' },
      );
      const session = await ctx.internalAdapter.createSession(user.id, false);
      const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET!);
      return `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
    }
    aliceCookie = await cookie('alice');
    bobCookie = await cookie('bob');
    await new D1ControlPlane(db).createAppEnvironmentKey(
      'legacy private app',
      'production',
      Date.now(),
    );
  }, 30_000);
  afterAll(async () => mf.dispose());

  function request(path: string, cookie = aliceCookie, body?: unknown) {
    return worker.fetch(
      new Request(`https://dashboard.example.com${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          cookie,
          origin: 'https://dashboard.example.com',
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
  }

  it('creates one workspace per account without claiming legacy projects', async () => {
    const account = await request('/v1/account');
    expect(account.status).toBe(200);
    const result = (await account.json()) as { workspace: { id: string } };
    const again = await request('/v1/account');
    expect(await again.json()).toMatchObject({ workspace: { id: result.workspace.id } });
    expect(await (await request('/v1/apps')).json()).toMatchObject({ apps: [] });
    const other = (await (await request('/v1/account', bobCookie)).json()) as {
      workspace: { id: string };
    };
    expect(other.workspace.id).not.toBe(result.workspace.id);
  });

  it('creates project and ownership atomically and lists only owned projects', async () => {
    const created = await request('/v1/apps', aliceCookie, {
      name: 'Alice API',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    aliceApp = (await created.json()) as typeof aliceApp;
    const listed = (await (await request('/v1/apps')).json()) as { apps: unknown[] };
    expect(listed.apps).toHaveLength(1);
    expect(await (await request('/v1/apps', bobCookie)).json()).toMatchObject({ apps: [] });
  });

  it('denies cross-account reads, key creation and revocation on every existing route', async () => {
    const query = `app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`;
    for (const route of ['endpoints', 'failures', 'logs', 'public-keys', 'installation/status']) {
      expect((await request(`/v1/${route}?${query}`, bobCookie)).status).toBe(403);
    }
    expect(
      (
        await request(
          `/v1/apps/${aliceApp.app.id}/environments/${aliceApp.environment.id}/revoke`,
          bobCookie,
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request('/v1/public-keys', bobCookie, {
          app_id: aliceApp.app.id,
          environment_id: aliceApp.environment.id,
          allowed_origins: ['https://site.example.com'],
        })
      ).status,
    ).toBe(403);
  });

  it('keeps legacy owner access limited to unclaimed projects and checks public-key ownership', async () => {
    const headers = { authorization: 'Bearer synthetic-owner' };
    const listed = await worker.fetch(
      new Request('https://dashboard.example.com/v1/apps', { headers }),
      env,
    );
    expect(await listed.json()).toMatchObject({ apps: [{ app: { name: 'legacy private app' } }] });
    expect(
      (
        await worker.fetch(
          new Request(
            `https://dashboard.example.com/v1/logs?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
            { headers },
          ),
          env,
        )
      ).status,
    ).toBe(403);
    for (const flag of ['disabled', undefined]) {
      const disabled = await worker.fetch(
        new Request('https://dashboard.example.com/v1/apps', { headers }),
        { ...env, APP_HEALTH_ACCOUNTS: flag },
      );
      expect(await disabled.json()).toMatchObject({
        apps: [{ app: { name: 'legacy private app' } }],
      });
    }
    const created = await request('/v1/public-keys', aliceCookie, {
      app_id: aliceApp.app.id,
      environment_id: aliceApp.environment.id,
      allowed_origins: ['https://site.example.com'],
    });
    expect(created.status).toBe(201);
    const key = (await created.json()) as { record: { id: string } };
    expect((await request(`/v1/public-keys/${key.record.id}/revoke`, bobCookie, {})).status).toBe(
      403,
    );
    expect((await request(`/v1/public-keys/${key.record.id}/revoke`, aliceCookie, {})).status).toBe(
      200,
    );
    expect((await request('/v1/public-keys/missing/revoke', aliceCookie, {})).status).toBe(403);
  });

  it('isolates browser workspaces, preserves queued events through presence failure, and bounds quotas', async () => {
    const keyResponse = await request('/v1/public-keys', aliceCookie, {
      app_id: aliceApp.app.id,
      environment_id: aliceApp.environment.id,
      allowed_origins: ['https://site.example.com'],
    });
    const publicKey = (await keyResponse.json()) as { key: string; record: { id: string } };
    const workspace = (await (await request('/v1/account')).json()) as {
      workspace: { id: string };
    };
    const heartbeat = vi.fn().mockResolvedValue(undefined);
    const snapshot = vi
      .fn()
      .mockResolvedValue({ measured_at: Date.now(), ttl_ms: 45000, total: 0, projects: [] });
    const getByName = vi.fn((_workspace: string) => ({
      heartbeat,
      snapshot,
      fetch: async () => new Response('upgrade', { status: 426 }),
    }));
    const send = vi.fn().mockResolvedValue(undefined);
    const production = {
      ...env,
      BROWSER_EVENTS: { send },
      BROWSER_HISTORY: { put: vi.fn(), list: vi.fn(), delete: vi.fn() },
      BROWSER_ARCHIVE: { getByName: () => ({ stage: vi.fn() }) },
      BROWSER_ANALYTICS: { writeDataPoint() {} },
      WORKSPACE_PRESENCE: { getByName },
    };
    const batch = {
      schema_version: 1,
      batch_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      public_key: publicKey.key,
      events: [
        {
          event_id: crypto.randomUUID(),
          timestamp: Date.now(),
          type: 'pageview',
          path: '/pricing',
        },
      ],
    };
    const collect = (body: unknown, bindings: Env = production) =>
      worker.fetch(
        new Request('https://ingest.example.com/v1/browser', {
          method: 'POST',
          headers: { origin: 'https://site.example.com' },
          body: JSON.stringify(body),
        }),
        bindings,
      );
    expect((await collect(batch)).status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: workspace.workspace.id, app_id: aliceApp.app.id }),
    );
    expect(getByName).toHaveBeenCalledWith(workspace.workspace.id);
    expect(heartbeat.mock.calls[0][2]).not.toBe(batch.session_id);
    heartbeat.mockRejectedValueOnce(new Error('presence offline'));
    expect(await (await collect(batch)).json()).toMatchObject({ accepted: 1, presence: false });
    heartbeat.mockRejectedValueOnce(new Error('presence offline'));
    expect((await collect({ ...batch, events: [] })).status).toBe(503);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await collect(batch, env)).status).toBe(503);
    send.mockRejectedValueOnce(new Error('queue offline'));
    expect((await collect(batch)).status).toBe(503);
    const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }));
    try {
      const response = await worker.fetch(
        new Request('https://dashboard.example.com/v1/analytics', {
          headers: { cookie: bobCookie },
        }),
        production,
      );
      expect(response.status).toBe(200);
      expect(String(provider.mock.calls[0][1]?.body)).not.toContain(workspace.workspace.id);
      expect(getByName.mock.calls.at(-1)?.[0]).not.toBe(workspace.workspace.id);
      provider.mockResolvedValueOnce(new Response(null, { status: 503 }));
      expect(
        (
          await worker.fetch(
            new Request('https://dashboard.example.com/v1/analytics', {
              headers: { cookie: aliceCookie },
            }),
            production,
          )
        ).status,
      ).toBe(503);
      for (const origin of ['https://evil.example.com', 'https://dashboard.example.com']) {
        const stream = await worker.fetch(
          new Request('https://dashboard.example.com/v1/analytics/live', {
            headers: { cookie: aliceCookie, origin },
          }),
          production,
        );
        expect(stream.status).toBe(origin.includes('evil') ? 403 : 426);
      }
    } finally {
      provider.mockRestore();
    }
    await env
      .DB!.prepare(
        'INSERT OR REPLACE INTO browser_log_quota (key_id, window_start, count) VALUES (?, ?, 6000)',
      )
      .bind(`analytics:${publicKey.record.id}`, Math.floor(Date.now() / 60000) * 60000)
      .run();
    expect((await collect(batch)).status).toBe(429);
  });

  it('scopes event reports to the signed-in workspace and rejects foreign project filters', async () => {
    const production = { ...env, BROWSER_ANALYTICS: { writeDataPoint() {} } };
    const account = (await (await request('/v1/account')).json()) as { workspace: { id: string } };
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ data: [] }));
    const report = (query = '', cookie = aliceCookie, bindings: Env = production) =>
      worker.fetch(
        new Request(`https://dashboard.example.com/v1/analytics/report${query}`, {
          headers: { cookie },
        }),
        bindings,
      );
    try {
      const response = await report('?range=1h&event=signup');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        source: 'analytics-engine',
        series: expect.any(Array),
        events: [],
      });
      expect(provider).toHaveBeenCalledTimes(8);
      for (const [, init] of provider.mock.calls) {
        expect(String(init?.body)).toContain(`index1 = '${account.workspace.id}'`);
        expect(String(init?.body)).toContain("blob5 = 'signup'");
      }
      provider.mockClear();
      expect((await report(`?app_id=${aliceApp.app.id}`, bobCookie)).status).toBe(403);
      expect((await report('?range=invalid')).status).toBe(400);
      expect((await report('?workspace=another')).status).toBe(400);
      expect((await report('', 'garbage')).status).toBe(401);
      expect(provider).not.toHaveBeenCalled();
      expect(
        (await report('', aliceCookie, { ...production, ANALYTICS_ENGINE_QUERY_TOKEN: undefined }))
          .status,
      ).toBe(503);
      provider.mockImplementation(async () => new Response(null, { status: 503 }));
      expect((await report()).status).toBe(503);
    } finally {
      provider.mockRestore();
    }
  });

  it('rejects expired or forged sessions and cross-origin cookie writes', async () => {
    expect((await request('/v1/apps', 'garbage')).status).toBe(401);
    const forged = new Request('https://dashboard.example.com/v1/apps', {
      method: 'POST',
      headers: { cookie: aliceCookie, origin: 'https://evil.example.com' },
      body: '{}',
    });
    expect((await worker.fetch(forged, env)).status).toBe(403);
    expect(accountMutationAllowed(new Request(forged, { headers: {} }))).toBe(false);
  });

  it('keeps environment capabilities and key rotation durable and account-scoped', async () => {
    const createdResponse = await request('/v1/apps', aliceCookie, {
      name: 'Environment foundation',
      environment: 'production',
      key_scope: 'environment',
    });
    const created = (await createdResponse.json()) as {
      app: { id: string };
      environment: { id: string };
      key: { key: string; environment_id: string };
    };
    expect(created.key.environment_id).toBe(created.environment.id);
    const base = `/v1/apps/${created.app.id}/environments`;
    const [one, two] = await Promise.all([
      request(base, aliceCookie, { name: 'staging' }),
      request(base, aliceCookie, { name: 'staging' }),
    ]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const staging = (await (one.status === 201 ? one : two).json()) as {
      environment: { id: string };
      key: { key: string };
    };
    const path = `/v1/capabilities?app_id=${created.app.id}&environment_id=${staging.environment.id}`;
    expect((await request(path, bobCookie)).status).toBe(403);
    expect((await request(`${base}/${staging.environment.id}/keys`, bobCookie, {})).status).toBe(
      403,
    );
    const control = new D1ControlPlane(env.DB!);
    const repos = control.asRepositories({} as never);
    await repos.capabilities!.setCapabilities(created.app.id, staging.environment.id, ['logs']);
    await repos.capabilities!.recordCapability(
      created.app.id,
      staging.environment.id,
      'logs',
      1000,
    );
    await repos.capabilities!.recordCapability(created.app.id, staging.environment.id, 'logs', 900);
    await repos.capabilities!.setCapabilities(created.app.id, staging.environment.id, []);
    await repos.capabilities!.recordCapability(
      created.app.id,
      staging.environment.id,
      'logs',
      2000,
    );
    const state = (await (await request(path)).json()) as {
      capabilities: {
        id: string;
        enabled: boolean;
        first_received_at: number | null;
        last_received_at: number | null;
      }[];
    };
    expect(state.capabilities.find((c) => c.id === 'logs')).toMatchObject({
      enabled: false,
      first_received_at: 1000,
      last_received_at: 2000,
    });
    expect(state.capabilities.find((c) => c.id === 'analytics')?.first_received_at).toBeNull();
    const rotated = (await (
      await request(`${base}/${staging.environment.id}/keys`, aliceCookie, {})
    ).json()) as { key: { key: string } };
    expect(await control.verifyKey(staging.key.key)).toBeNull();
    expect(await control.verifyKey(rotated.key.key)).not.toBeNull();
    expect(await control.verifyKey(created.key.key)).not.toBeNull();
    const invalidScope = await request(
      `/v1/capabilities?app_id=${created.app.id}&environment_id=${aliceApp.environment.id}`,
    );
    expect(invalidScope.status).toBe(404);
  });

  it('backfills legacy receipt history idempotently without resetting capability choices', async () => {
    const control = new D1ControlPlane(env.DB!);
    const created = await control.createAppEnvironmentKey(
      'Legacy receipt',
      'production',
      Date.now(),
    );
    await control.recordIngest(created.app.id, created.environment.id, 'worker', 1000);
    await control.recordLogs(
      created.app.id,
      created.environment.id,
      [
        {
          log_id: crypto.randomUUID(),
          timestamp: 1200,
          event: 'legacy.accepted',
          level: 'info',
          props: {},
        },
      ],
      'server',
    );
    const sql = await readFile(
      new URL('../migrations/0008_environment_capabilities.sql', import.meta.url),
      'utf8',
    );
    const statements = sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((s) => s.trim());
    for (const statement of statements) await env.DB!.prepare(statement).run();
    const capabilities = control.asRepositories({} as never).capabilities!;
    expect(await capabilities.getCapabilities(created.app.id, created.environment.id)).toEqual([
      { id: 'analytics', enabled: false, first_received_at: null, last_received_at: null },
      { id: 'endpoints', enabled: true, first_received_at: 1000, last_received_at: 1000 },
      { id: 'logs', enabled: true, first_received_at: 1200, last_received_at: 1200 },
    ]);
    await capabilities.setCapabilities(created.app.id, created.environment.id, []);
    for (const statement of statements) await env.DB!.prepare(statement).run();
    expect(
      (await capabilities.getCapabilities(created.app.id, created.environment.id)).every(
        (c) => !c.enabled,
      ),
    ).toBe(true);
  });

  it('revokes the actual session on sign-out', async () => {
    const response = await request('/v1/auth/sign-out', bobCookie, {});
    expect(response.status).toBe(200);
    expect((await request('/v1/apps', bobCookie)).status).toBe(401);
  });

  it('starts Google OAuth with state and PKCE and blocks foreign callbacks', async () => {
    const response = await request('/v1/auth/sign-in/social', aliceCookie, {
      provider: 'google',
      callbackURL: '/',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    const destination = new URL(body.url);
    expect(destination.origin).toBe('https://accounts.google.com');
    expect(destination.searchParams.get('redirect_uri')).toBe(
      'https://dashboard.example.com/v1/auth/callback/google',
    );
    expect(destination.searchParams.get('state')).toBeTruthy();
    expect(destination.searchParams.get('code_challenge_method')).toBe('S256');
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(
      (
        await request('/v1/auth/sign-in/social', aliceCookie, {
          provider: 'google',
          callbackURL: 'https://evil.example.com',
        })
      ).status,
    ).toBe(403);
    const invalidCallback = await request('/v1/auth/callback/google?code=forged&state=unknown');
    expect(invalidCallback.status).toBe(302);
    expect(invalidCallback.headers.get('location')).toContain('error=');
  });

  it('rejects expired sessions and unverified accounts', async () => {
    const ctx = await createAccountAuth(env)!.$context;
    const user = await ctx.internalAdapter.createUser(
      { name: 'unverified', email: 'unverified@example.com', emailVerified: false },
      { method: 'oauth' },
    );
    const session = await ctx.internalAdapter.createSession(user.id, false);
    const signature = await makeSignature(session.token, env.BETTER_AUTH_SECRET!);
    const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${session.token}.${signature}`)}`;
    expect((await request('/v1/apps', cookie)).status).toBe(401);
    await env.DB!.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(user.id).run();
    await ctx.internalAdapter.updateSession(session.token, { expiresAt: new Date(0) });
    expect((await request('/v1/apps', cookie)).status).toBe(401);
  });

  it('fails closed when Google configuration is incomplete and rejects ingest-host auth', async () => {
    expect(createAccountAuth({ ...env, GOOGLE_CLIENT_SECRET: undefined })).toBeNull();
    expect(createAccountAuth({ ...env, BETTER_AUTH_SECRET: 'short' })).toBeNull();
    const response = await worker.fetch(
      new Request('https://ingest.example.com/v1/auth/get-session'),
      env,
    );
    expect(response.status).toBe(404);
    await expect(personalWorkspace(env.DB!, 'missing-user')).rejects.toThrow();
  });
});
