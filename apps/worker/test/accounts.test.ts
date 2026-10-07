import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { makeSignature } from 'better-auth/crypto';
import {
  accountIdentity,
  createAccountAuth,
  personalWorkspace,
  accountMutationAllowed,
  type OwnerRequestTimings,
} from '../src/accounts.js';
import worker, { type Env } from '../src/index.js';
import {
  D1ControlPlane,
  type D1DatabaseLike,
  type D1PreparedStatement,
} from '../src/d1-adapter.js';

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
      '0013_archive_projects.sql',
      '0014_endpoint_rollups.sql',
      '0015_response_payload_bytes.sql',
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const statement of sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((s) => s.trim()))
        await db.prepare(statement).run();
    }
    const catalogMigration = await readFile(
      new URL('../migrations/0018_catalog_imports.sql', import.meta.url),
      'utf8',
    );
    for (const statement of catalogMigration
      .replace(/--[^\n]*/g, '')
      .trim()
      .split(/\n(?=CREATE )/))
      await db.prepare(statement).run();
    for (const file of [
      '0019_browser_visitor_days.sql',
      '0020_browser_receipt_reconciliation.sql',
      '0021_browser_event_facts_digest.sql',
      '0022_browser_archive_audit_jobs.sql',
      '0023_browser_queue_stage_receipts.sql',
      '0024_browser_archive_queue_evidence.sql',
      '0025_browser_visitor_acceptance_coverage.sql',
      '0026_browser_visitor_day_seals.sql',
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

  it.each([
    ['portfolio-briefing', 'portfolio-briefing-v1'],
    ['daily-engagement', 'daily-briefing-v2'],
  ])(
    'serves cached %s after owner authentication with private timing stages',
    async (route, cacheKey) => {
      const cache = {
        match: vi.fn(async (key: Request) =>
          key.url.includes(cacheKey)
            ? Response.json({ products: [], marker: 'cached-briefing' })
            : undefined,
        ),
        put: vi.fn(async () => {}),
      };
      const captures = vi.fn(async () => ({ coverageStart: '2026-09-28', rows: [] }));
      let catalogReads = 0;
      const db = env.DB!;
      const scopedEnv: Env = {
        ...env,
        DB: new Proxy(db, {
          get(target, key, receiver) {
            if (key === 'prepare')
              return (sql: string) => {
                if (sql.includes('catalog_project_imports')) catalogReads += 1;
                return target.prepare(sql);
              };
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
        SAASMAKER_METRICS: { getDailyCaptureCounts: captures },
      };
      vi.stubGlobal('caches', { default: cache });
      try {
        const path = `https://dashboard.example.com/v1/reports/${route}?date=2026-09-28&private_marker=not-for-timing`;
        const anonymous = await worker.fetch(new Request(path), scopedEnv);
        expect(anonymous.status).toBe(401);
        expect(anonymous.headers.get('server-timing')).toBeNull();
        expect(cache.match).not.toHaveBeenCalled();
        const response = await worker.fetch(
          new Request(path, { headers: { cookie: aliceCookie } }),
          scopedEnv,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('server-timing')).toMatch(
          /^auth_setup;dur=\d+\.\d{2}, session_lookup;dur=\d+\.\d{2}, session_db_read;dur=\d+\.\d{2}, workspace_scope;dur=\d+\.\d{2}, route_read;dur=\d+\.\d{2}, owner_handler_total;dur=\d+\.\d{2}$/,
        );
        await expect(response.json()).resolves.toEqual({ products: [], marker: 'cached-briefing' });
        expect(cache.match).toHaveBeenCalledTimes(1);
        expect(catalogReads).toBe(0);
        expect(captures).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

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

  it('joins live account scope and capability setup while preserving route authorization and key semantics', async () => {
    expect(
      (
        await request(
          `/v1/capabilities?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
          bobCookie,
        )
      ).status,
    ).toBe(403);
    const aliceCreated = await request('/v1/apps', aliceCookie, {
      name: 'Alice capability setup API',
      environment: 'production',
    });
    expect(aliceCreated.status).toBe(201);
    const ownedApp = (await aliceCreated.json()) as typeof aliceApp;
    const bobCreated = await request('/v1/apps', bobCookie, {
      name: 'Bob API',
      environment: 'production',
    });
    expect(bobCreated.status).toBe(201);
    const bobApp = (await bobCreated.json()) as typeof aliceApp;
    const path = (appId: string, environmentId: string) =>
      `/v1/capabilities?app_id=${appId}&environment_id=${environmentId}`;

    const initial = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as {
      capabilities: { id: string; enabled: boolean }[];
    };
    expect(initialBody.capabilities.every((capability) => !capability.enabled)).toBe(true);

    await env.DB!.prepare('DELETE FROM keys WHERE app_id = ?').bind(ownedApp.app.id).run();
    await env.DB!.prepare('DELETE FROM product_keys WHERE app_id = ?').bind(ownedApp.app.id).run();
    await env
      .DB!.prepare(
        'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .bind('alice-environment-key', ownedApp.app.id, ownedApp.environment.id, 'hash-env', 10)
      .run();
    await env
      .DB!.prepare(
        'INSERT INTO product_keys (id, app_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, NULL)',
      )
      .bind('alice-product-key', ownedApp.app.id, 'hash-product', 20)
      .run();
    const productKey = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(((await productKey.json()) as { private_key: unknown }).private_key).toMatchObject({
      id: 'alice-product-key',
      environment_id: null,
    });

    await env
      .DB!.prepare(
        'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
      )
      .bind(
        'alice-newer-environment-key',
        ownedApp.app.id,
        ownedApp.environment.id,
        'hash-env-new',
        30,
      )
      .run();
    const environmentKey = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(((await environmentKey.json()) as { private_key: unknown }).private_key).toMatchObject({
      id: 'alice-newer-environment-key',
      environment_id: ownedApp.environment.id,
    });
    await env
      .DB!.prepare('UPDATE keys SET revoked_at = 40 WHERE id = ?')
      .bind('alice-newer-environment-key')
      .run();
    const fallbackKey = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(((await fallbackKey.json()) as { private_key: unknown }).private_key).toMatchObject({
      id: 'alice-product-key',
    });
    await env
      .DB!.prepare('UPDATE product_keys SET revoked_at = 50 WHERE id = ?')
      .bind('alice-product-key')
      .run();
    await env
      .DB!.prepare('UPDATE keys SET revoked_at = 60 WHERE id = ?')
      .bind('alice-environment-key')
      .run();
    const noActiveKey = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(((await noActiveKey.json()) as { private_key: unknown }).private_key).toBeNull();

    await env
      .DB!.prepare(
        'INSERT INTO environment_capabilities (app_id, environment_id, capability, enabled, first_received_at, last_received_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(ownedApp.app.id, ownedApp.environment.id, 'analytics', 1, 101, 202)
      .run();
    const withCapability = await request(path(ownedApp.app.id, ownedApp.environment.id));
    expect(
      ((await withCapability.json()) as { capabilities: unknown[] }).capabilities,
    ).toContainEqual({
      id: 'analytics',
      enabled: true,
      first_received_at: 101,
      last_received_at: 202,
    });

    expect((await request(path(ownedApp.app.id, ownedApp.environment.id), bobCookie)).status).toBe(
      403,
    );
    expect((await request(path(ownedApp.app.id, bobApp.environment.id))).status).toBe(404);
    expect((await request(path(ownedApp.app.id, 'missing-environment'))).status).toBe(404);

    await env
      .DB!.prepare('UPDATE apps SET archived_at = ? WHERE id = ?')
      .bind(Date.now(), ownedApp.app.id)
      .run();
    expect((await request(path(ownedApp.app.id, ownedApp.environment.id))).status).toBe(403);
    await env
      .DB!.prepare('UPDATE apps SET archived_at = ? WHERE id = ?')
      .bind(Date.now(), bobApp.app.id)
      .run();
  });

  it('loads the live session and user in one read before the joined workspace scope', async () => {
    const statements: string[] = [];
    const db = env.DB!;
    const countedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const identity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/apps', {
        headers: { cookie: aliceCookie },
      }),
      { ...env, DB: countedDb },
    );
    expect(identity?.workspace.id).toBeTruthy();
    expect(identity?.owner.appIds).toContain(aliceApp.app.id);
    const sessionReads = statements.filter((sql) => /from "session"/i.test(sql));
    expect(sessionReads).toHaveLength(1);
    expect(sessionReads[0]).toMatch(/join "user"/i);
    expect(statements.filter((sql) => /from "user"/i.test(sql))).toHaveLength(0);
    const workspaceReads = statements.filter((sql) => /FROM workspaces w/.test(sql));
    expect(workspaceReads).toHaveLength(1);
    expect(workspaceReads[0]).toContain('LEFT JOIN workspace_apps wa ON wa.workspace_id = w.id');
    expect(workspaceReads[0]).toContain(
      'LEFT JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL',
    );
  });

  it('authorizes endpoint reads from the requested app in a large real-D1 workspace', async () => {
    const identity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/account', { headers: { cookie: aliceCookie } }),
      env,
    );
    expect(identity).not.toBeNull();
    const workspaceId = identity!.workspace.id;
    const current = await env
      .DB!.prepare('SELECT COUNT(*) AS count FROM workspace_apps WHERE workspace_id = ?')
      .bind(workspaceId)
      .first<{ count: number }>();
    const additionalApps = Math.max(0, 56 - (current?.count ?? 0));
    for (let index = 0; index < additionalApps; index++) {
      const appId = `alice-scope-fixture-${index}`;
      await env
        .DB!.prepare('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)')
        .bind(appId, `Scope fixture ${index}`, index)
        .run();
      await env
        .DB!.prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
        .bind(appId, workspaceId)
        .run();
    }
    const fixtureSize = await env
      .DB!.prepare('SELECT COUNT(*) AS count FROM workspace_apps WHERE workspace_id = ?')
      .bind(workspaceId)
      .first<{ count: number }>();
    expect(fixtureSize?.count).toBe(56);

    const statements: string[] = [];
    const db = env.DB!;
    const countedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ data: [] }));
    let archivedFixtureMutated = false;
    try {
      const owned = await worker.fetch(
        new Request(
          `https://dashboard.example.com/v1/endpoints?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
          { headers: { cookie: aliceCookie } },
        ),
        { ...env, DB: countedDb },
      );
      expect(owned.status).toBe(200);
      const scopeReads = statements.filter((sql) => /FROM workspaces w/.test(sql));
      expect(scopeReads).toHaveLength(1);
      expect(scopeReads[0]).toContain('EXISTS (');
      expect(scopeReads[0]).toContain('wa.app_id = ?');
      expect(scopeReads[0]).toContain('a.archived_at IS NULL');
      expect(scopeReads[0]).not.toContain('LEFT JOIN workspace_apps');

      const foreign = await request(
        `/v1/endpoints?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
        bobCookie,
      );
      expect(foreign.status).toBe(403);

      await env
        .DB!.prepare('UPDATE apps SET archived_at = ? WHERE id = ?')
        .bind(Date.now(), aliceApp.app.id)
        .run();
      archivedFixtureMutated = true;
      const archived = await request(
        `/v1/endpoints?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
      );
      expect(archived.status).toBe(403);

      expect((await request('/v1/endpoints')).status).toBe(400);
      expect(
        (await request(`/v1/endpoints?app_id=&environment_id=${aliceApp.environment.id}`)).status,
      ).toBe(400);

      const auth = createAccountAuth(env)!;
      const authContext = await auth.$context;
      const firstUser = await authContext.internalAdapter.createUser(
        { name: 'first-session', email: 'first-session@example.com', emailVerified: true },
        { method: 'oauth' },
      );
      const firstSession = await authContext.internalAdapter.createSession(firstUser.id, false);
      const signature = await makeSignature(firstSession.token, env.BETTER_AUTH_SECRET!);
      const firstCookie = `__Secure-better-auth.session_token=${encodeURIComponent(`${firstSession.token}.${signature}`)}`;
      const firstRequest = await request(
        `/v1/endpoints?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
        firstCookie,
      );
      expect(firstRequest.status).toBe(403);
      const firstWorkspace = await request('/v1/account', firstCookie);
      expect(firstWorkspace.status).toBe(200);
      const firstWorkspaceBody = (await firstWorkspace.json()) as { workspace: { id: string } };
      expect(firstWorkspaceBody.workspace.id).toBeTruthy();
    } finally {
      provider.mockRestore();
      if (archivedFixtureMutated)
        await env
          .DB!.prepare('UPDATE apps SET archived_at = NULL WHERE id = ?')
          .bind(aliceApp.app.id)
          .run();
      for (let index = 0; index < additionalApps; index++) {
        const appId = `alice-scope-fixture-${index}`;
        await env.DB!.prepare('DELETE FROM workspace_apps WHERE app_id = ?').bind(appId).run();
        await env.DB!.prepare('DELETE FROM apps WHERE id = ?').bind(appId).run();
      }
    }
  });

  it('loads capability scope and setup with one D1 read after live session validation', async () => {
    const expectedIdentity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/account', {
        headers: { cookie: aliceCookie },
      }),
      env,
    );
    expect(expectedIdentity).not.toBeNull();
    const expected = await new D1ControlPlane(
      env.DB!,
      expectedIdentity!.workspace.id,
    ).getCapabilitySetup(aliceApp.app.id, aliceApp.environment.id);
    expect(expected).not.toBeNull();

    let roundTrips = 0;
    const originals = new WeakMap<object, D1PreparedStatement>();
    const countedDb = new Proxy(env.DB! as D1DatabaseLike, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            let statement = target.prepare(sql);
            const proxy = new Proxy(statement, {
              get(_prepared, method) {
                if (method === 'bind')
                  return (...values: unknown[]) => {
                    statement = statement.bind(...values);
                    originals.set(proxy, statement);
                    return proxy;
                  };
                const value = Reflect.get(statement, method, statement);
                if (['first', 'all', 'run'].includes(String(method)))
                  return (...args: unknown[]) => {
                    roundTrips += 1;
                    return value.apply(statement, args);
                  };
                return typeof value === 'function' ? value.bind(statement) : value;
              },
            });
            originals.set(proxy, statement);
            return proxy;
          };
        if (key === 'batch')
          return (statements: D1PreparedStatement[]) => {
            roundTrips += 1;
            return target.batch(
              statements.map((statement) => originals.get(statement) ?? statement),
            );
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      new Request(
        `https://dashboard.example.com/v1/capabilities?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
        { headers: { cookie: aliceCookie } },
      ),
      { ...env, DB: countedDb },
    );
    expect(response.status).toBe(200);
    expect(roundTrips).toBe(2);
    const actual = (await response.json()) as {
      capabilities: unknown[];
      private_key: unknown;
    };
    expect(actual.capabilities).toEqual(expected!.capabilities);
    expect(actual.private_key).toEqual(expected!.private_key);
  });

  it('matches the two-read app inventory for multiple ordered environments in one scoped read', async () => {
    const secondProjectResponse = await request('/v1/apps', aliceCookie, {
      name: 'Alice older API',
      environment: 'production',
    });
    expect(secondProjectResponse.status).toBe(201);
    const secondProject = (await secondProjectResponse.json()) as typeof aliceApp;
    const extraEnvironmentId = 'env-alice-staging';
    await env
      .DB!.prepare('UPDATE apps SET created_at = 2000 WHERE id = ?')
      .bind(aliceApp.app.id)
      .run();
    await env
      .DB!.prepare('UPDATE environments SET created_at = 30 WHERE id = ?')
      .bind(aliceApp.environment.id)
      .run();
    await env
      .DB!.prepare('UPDATE apps SET created_at = 1000 WHERE id = ?')
      .bind(secondProject.app.id)
      .run();
    await env
      .DB!.prepare('UPDATE environments SET created_at = 40 WHERE id = ?')
      .bind(secondProject.environment.id)
      .run();
    await env
      .DB!.prepare('INSERT INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
      .bind(extraEnvironmentId, aliceApp.app.id, 'staging', 20)
      .run();

    const identity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/apps', { headers: { cookie: aliceCookie } }),
      env,
    );
    expect(identity).not.toBeNull();
    const baselineRepos = new D1ControlPlane(env.DB!, identity!.workspace.id).asRepositories(
      {} as never,
    );
    const baselineApps = await baselineRepos.apps.listApps();
    const baselineEnvironments = await baselineRepos.environments.listEnvironmentsForApps(
      baselineApps.map((app) => app.id),
    );
    const environmentsByApp = new Map<string, typeof baselineEnvironments>();
    for (const environment of baselineEnvironments) {
      const group = environmentsByApp.get(environment.app_id) ?? [];
      group.push(environment);
      environmentsByApp.set(environment.app_id, group);
    }
    const baseline = baselineApps.map((app) => ({
      app,
      environments: environmentsByApp.get(app.id) ?? [],
    }));

    const statements: string[] = [];
    const db = env.DB!;
    const countedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      new Request('https://dashboard.example.com/v1/apps', { headers: { cookie: aliceCookie } }),
      { ...env, DB: countedDb },
    );
    expect(response.status).toBe(200);
    const listed = (await response.json()) as {
      apps: Array<{ app: { id: string }; environments: Array<{ id: string }> }>;
    };
    expect(listed.apps).toEqual(baseline);
    expect(listed.apps.map(({ app }) => app.id)).toEqual([aliceApp.app.id, secondProject.app.id]);
    expect(listed.apps[0].environments.map(({ id }) => id)).toEqual([
      extraEnvironmentId,
      aliceApp.environment.id,
    ]);
    expect(listed.apps[1].environments.map(({ id }) => id)).toEqual([secondProject.environment.id]);
    expect(listed.apps.filter(({ app }) => app.id === aliceApp.app.id)).toHaveLength(1);
    expect(await (await request('/v1/apps', bobCookie)).json()).toEqual({ apps: [] });
    const sessionReads = statements.filter((sql) => /from "session"/i.test(sql));
    const workspaceReads = statements.filter((sql) => /FROM workspaces w/.test(sql));
    expect(sessionReads).toHaveLength(1);
    expect(sessionReads[0]).toMatch(/join "user"/i);
    expect(workspaceReads).toHaveLength(1);
    expect(workspaceReads[0]).toContain(
      'LEFT JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL',
    );
    expect(workspaceReads[0]).toContain('LEFT JOIN environments e ON e.app_id = a.id');
    expect(statements.some((sql) => /FROM apps a/.test(sql))).toBe(false);
  });

  it('lets the cookie-authenticated workspace owner start and poll an archive audit', async () => {
    const created = await request('/v1/apps', aliceCookie, {
      name: 'Archive audit owner fixture',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const identity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/apps', {
        headers: { cookie: aliceCookie },
      }),
      env,
    );
    expect(identity?.owner.workspaceId).toBeTruthy();
    expect(identity?.owner.appIds?.length).toBeGreaterThan(0);

    env.BROWSER_ARCHIVE = {
      getByName: () => ({
        archiveSegmentsForEventDay: async () => ({
          segments: [],
          next_cursor: null,
          snapshot_sequence: 0,
        }),
        archiveSegmentForBatch: async () => null,
      }),
    } as unknown as Env['BROWSER_ARCHIVE'];
    env.BROWSER_HISTORY = { get: async () => null } as unknown as Env['BROWSER_HISTORY'];

    const started = await request('/v1/browser/archive-audits?day=2026-08-01', aliceCookie, {});
    expect(started.status).toBe(202);
    const startedBody = (await started.json()) as { job_id: string; complete: boolean };
    expect(startedBody.complete).toBe(false);

    const status = await request(`/v1/browser/archive-audits/${startedBody.job_id}`, aliceCookie);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ job_id: startedBody.job_id, complete: false });

    const hidden = await request(`/v1/browser/archive-audits/${startedBody.job_id}`, bobCookie);
    expect(hidden.status).toBe(404);
  });

  it('returns anonymous Server-Timing stages only on authenticated owner read paths', async () => {
    const apps = await request('/v1/apps?private_marker=not-for-timing');
    const capabilities = await request(
      `/v1/capabilities?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
    );
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ data: [] }));
    let endpoints: Response;
    try {
      endpoints = await request(
        `/v1/endpoints?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
      );
    } finally {
      provider.mockRestore();
    }
    const installation = await request(
      `/v1/installation/status?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`,
    );
    const analyticsReport = await request('/v1/analytics/report');
    const alerts = await request('/v1/workspace/alerts');
    const timingPattern =
      /^auth_setup;dur=\d+\.\d{2}, session_lookup;dur=\d+\.\d{2}, session_db_read;dur=\d+\.\d{2}, (?:workspace_scope;dur=\d+\.\d{2}|workspace_capability_setup_read;dur=\d+\.\d{2})(?:, apps_projection;dur=\d+\.\d{2})?(?:, capability_setup_read;dur=\d+\.\d{2})?, route_read;dur=\d+\.\d{2}, owner_handler_total;dur=\d+\.\d{2}$/;
    for (const [response, status] of [
      [apps, 200],
      [capabilities, 200],
      [endpoints, 200],
      [installation, 200],
      [analyticsReport, 503],
      [alerts, 200],
    ] as const) {
      expect(response.status).toBe(status);
      const header = response.headers.get('server-timing') ?? '';
      expect(header).toMatch(timingPattern);
      expect(header).not.toContain('auth_db');
      expect(header).not.toContain('user_db_read');
      expect(header).not.toContain(aliceApp.app.id);
      expect(header).not.toContain(aliceCookie);
      expect(header).not.toContain('alice@example.com');
      expect(header).not.toContain('not-for-timing');
      expect(header).not.toMatch(/SELECT|FROM/i);
    }
    expect(capabilities.headers.get('server-timing')).toContain(
      'workspace_capability_setup_read;dur=',
    );
    expect(capabilities.headers.get('server-timing')).not.toMatch(/, capability_setup_read;/);
    const appsTiming = apps.headers.get('server-timing') ?? '';
    const appsStages = [
      'workspace_scope;',
      'apps_projection;',
      'route_read;',
      'owner_handler_total;',
    ];
    for (let index = 0; index < appsStages.length; index++) {
      expect(appsTiming).toContain(appsStages[index]);
      if (index > 0)
        expect(appsTiming.indexOf(appsStages[index - 1]!)).toBeLessThan(
          appsTiming.indexOf(appsStages[index]!),
        );
    }
    expect(apps.headers.get('server-timing')).not.toContain('capability_setup_read');
    expect(capabilities.headers.get('server-timing')).not.toContain('apps_projection');
    const duration = (name: string) =>
      Number(new RegExp(name + ';dur=(\\d+\\.\\d{2})').exec(appsTiming)?.[1]);
    expect(duration('owner_handler_total')).toBeGreaterThanOrEqual(duration('route_read'));
    expect(duration('owner_handler_total')).toBeGreaterThanOrEqual(duration('apps_projection'));

    const unauthenticated = await worker.fetch(
      new Request('https://dashboard.example.com/v1/apps'),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('server-timing')).toBeNull();
    expect((await request('/v1/account')).headers.get('server-timing')).toBeNull();
    for (const path of [
      '/v1/endpoints',
      '/v1/installation/status',
      '/v1/analytics/report',
      '/v1/reports/daily-engagement',
      '/v1/reports/portfolio-briefing',
      '/v1/workspace/alerts',
    ]) {
      const response = await worker.fetch(new Request(`https://dashboard.example.com${path}`), env);
      expect(response.status).toBe(401);
      expect(response.headers.get('server-timing')).toBeNull();
    }
  });

  it('accumulates timings for actual joined session and direct user reads', async () => {
    const timings: OwnerRequestTimings = {};
    const auth = createAccountAuth(env, timings)!;
    const headers = new Headers({ cookie: aliceCookie });
    await auth.api.getSession({ headers });
    const firstSessionReadMs = timings.sessionDbReadMs;
    await auth.api.getSession({ headers });
    expect(timings.sessionDbReadMs).toBeGreaterThan(firstSessionReadMs ?? 0);
    expect(timings.userDbReadMs).toBeUndefined();
    const ctx = await auth.$context;
    await ctx.internalAdapter.findUserByEmail('alice@example.com');
    const firstUserReadMs = timings.userDbReadMs;
    expect(firstUserReadMs).toBeGreaterThan(0);
    await ctx.internalAdapter.findUserByEmail('alice@example.com');
    expect(timings.userDbReadMs).toBeGreaterThan(firstUserReadMs ?? 0);
  });

  it('keeps the public get-session D1 limit while owner reads do not consume it', async () => {
    const ip = '203.0.113.87';
    const authRequest = (path: string, body?: unknown, cookie?: string) =>
      worker.fetch(
        new Request(`https://dashboard.example.com${path}`, {
          method: body ? 'POST' : 'GET',
          headers: new Headers({
            'cf-connecting-ip': ip,
            origin: 'https://dashboard.example.com',
            'content-type': 'application/json',
            ...(cookie ? { cookie } : {}),
          }),
          body: body ? JSON.stringify(body) : undefined,
        }),
        env,
      );
    const rateLimitCount = async () =>
      (
        await env
          .DB!.prepare('SELECT COALESCE(SUM(count), 0) AS count FROM rateLimit')
          .first<{ count: number }>()
      )?.count ?? 0;
    const before = await rateLimitCount();

    const publicSession = await authRequest('/v1/auth/get-session');
    expect(publicSession.status).toBe(200);
    expect(await publicSession.json()).toBeNull();
    const afterPublicSession = await rateLimitCount();
    expect(afterPublicSession).toBeGreaterThan(before);

    const ownerRead = await authRequest('/v1/apps', undefined, aliceCookie);
    expect(ownerRead.status).toBe(200);
    expect(await rateLimitCount()).toBe(afterPublicSession);

    const signInBody = { provider: 'google', callbackURL: '/' };
    for (let i = 0; i < 3; i++)
      expect((await authRequest('/v1/auth/sign-in/social', signInBody)).status).toBe(200);
    expect((await authRequest('/v1/auth/sign-in/social', signInBody)).status).toBe(429);
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
    const inventoryQueries: string[] = [];
    const db = env.DB!;
    const countedDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            inventoryQueries.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const listed = await worker.fetch(
      new Request('https://dashboard.example.com/v1/apps', { headers }),
      { ...env, DB: countedDb },
    );
    expect(await listed.json()).toMatchObject({ apps: [{ app: { name: 'legacy private app' } }] });
    expect(inventoryQueries.filter((sql) => /\bFROM apps\b/.test(sql))).toHaveLength(1);
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
      BROWSER_ARCHIVE: {
        getByName: () => ({
          stage: vi.fn(),
          lookupStaged: vi.fn().mockResolvedValue({ staged: [], missing: 0 }),
        }),
      },
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
    const scopedSetup = await repos.capabilitySetup!.getCapabilitySetup(
      created.app.id,
      staging.environment.id,
    );
    expect(scopedSetup?.private_key).toMatchObject({
      environment_id: staging.environment.id,
      revoked_at: null,
    });
    expect(scopedSetup?.private_key).not.toHaveProperty('verifier_hash');
    expect(
      await repos.capabilitySetup!.getCapabilitySetup('another-app', staging.environment.id),
    ).toBeNull();
    expect(
      await repos.capabilitySetup!.getCapabilitySetup(created.app.id, 'missing-environment'),
    ).toBeNull();
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
      app_id: string;
      environment_id: string;
      capabilities: {
        id: string;
        enabled: boolean;
        first_received_at: number | null;
        last_received_at: number | null;
      }[];
      private_key: {
        id: string;
        environment_id: string | null;
        created_at: number;
        revoked_at: number | null;
      } | null;
    };
    expect(state.app_id).toBe(created.app.id);
    expect(state.environment_id).toBe(staging.environment.id);
    expect(state.private_key?.environment_id).toBe(staging.environment.id);
    expect(Object.keys(state.private_key ?? {}).sort()).toEqual([
      'created_at',
      'environment_id',
      'id',
      'revoked_at',
    ]);
    expect(JSON.stringify(state)).not.toContain(created.key.key);
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
    expect(await invalidScope.json()).toEqual({ error: 'Environment not found' });
  });

  it('imports declared catalog identities atomically and idempotently without keys or cross-account claims', async () => {
    const project = {
      catalog_id: 'catalog-canary',
      name: 'Catalog canary',
      lifecycle: 'active',
      hostname: 'example.com',
      repository: 'https://github.com/example/project',
    };
    const input = { schema_version: 1, projects: [project] };
    const path = '/v1/catalog/import';
    expect((await request(path, 'garbage', input)).status).toBe(401);
    const before = await env
      .DB!.prepare('SELECT COUNT(*) AS total FROM keys')
      .first<{ total: number }>();
    const [one, two] = await Promise.all([
      request(path, aliceCookie, input),
      request(path, aliceCookie, input),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    const imported = (await one.json()) as {
      projects: { app_id: string; verification_state: string }[];
    };
    expect(await two.json()).toEqual(imported);
    expect(imported.projects[0].verification_state).toBe('declared');
    expect(await env.DB!.prepare('SELECT COUNT(*) AS total FROM keys').first()).toEqual(before);
    const mapping = await env
      .DB!.prepare('SELECT * FROM catalog_project_imports WHERE app_id = ?')
      .bind(imported.projects[0].app_id)
      .first();
    expect(mapping).toMatchObject({
      catalog_id: project.catalog_id,
      hostname: project.hostname,
      repository: project.repository,
      lifecycle: 'active',
      verification_state: 'declared',
    });
    const foreign = await request(path, bobCookie, {
      schema_version: 1,
      projects: [{ ...project, existing_app_id: aliceApp.app.id }],
    });
    expect(foreign.status).toBe(409);
    const other = await request(path, bobCookie, input);
    expect(other.status).toBe(200);
    expect(await other.json()).not.toEqual(imported);
    const appsBefore = await env.DB!.prepare('SELECT COUNT(*) AS total FROM apps').first();
    const conflict = await request(path, aliceCookie, {
      schema_version: 1,
      projects: [
        { ...project, catalog_id: 'rollback-new' },
        { ...project, name: 'Conflicting rename' },
      ],
    });
    expect(conflict.status).toBe(409);
    expect(await env.DB!.prepare('SELECT COUNT(*) AS total FROM apps').first()).toEqual(appsBefore);
    expect(
      await env
        .DB!.prepare(
          "SELECT COUNT(*) AS total FROM catalog_project_imports WHERE catalog_id = 'rollback-new'",
        )
        .first(),
    ).toMatchObject({ total: 0 });
    const explicit = await request(path, aliceCookie, {
      schema_version: 1,
      projects: [{ ...project, catalog_id: 'existing-owned', existing_app_id: aliceApp.app.id }],
    });
    expect(explicit.status).toBe(200);
    expect(await env.DB!.prepare('SELECT COUNT(*) AS total FROM apps').first()).toEqual(appsBefore);
  });

  it('bounds and validates catalog imports and requires an account workspace', async () => {
    const path = '/v1/catalog/import';
    const project = { catalog_id: 'invalid', name: 'Invalid', lifecycle: 'active' };
    expect(
      (await request(path, aliceCookie, { schema_version: 1, projects: [project, project] }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(path, aliceCookie, {
          schema_version: 1,
          projects: [{ ...project, repository: 'https://token@github.com/owner/repo' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(path, aliceCookie, {
          schema_version: 1,
          projects: [{ ...project, secret: 'must-reject' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(path, aliceCookie, {
          schema_version: 1,
          projects: Array.from({ length: 11 }, (_, i) => ({
            ...project,
            catalog_id: `project-${i}`,
          })),
        })
      ).status,
    ).toBe(400);
    expect((await request(path, aliceCookie, { oversized: 'x'.repeat(33 * 1024) })).status).toBe(
      413,
    );
    expect((await request(path, aliceCookie)).status).toBe(405);
    const owner = await worker.fetch(
      new Request(`https://dashboard.example.com${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-owner' },
        body: JSON.stringify({ schema_version: 1, projects: [project] }),
      }),
      env,
    );
    expect(owner.status).toBe(403);
  });

  it('requires a valid owning account for capability ledger reads', async () => {
    const path = `/v1/capabilities/ledger?app_id=${aliceApp.app.id}&environment_id=${aliceApp.environment.id}`;
    expect((await request(path, 'garbage')).status).toBe(401);
    expect((await request(path, bobCookie)).status).toBe(403);
    const response = await request(path, aliceCookie);
    expect(response.status).toBe(200);
    const ledger = (await response.json()) as {
      app_id: string;
      environment_id: string;
      collection: unknown[];
    };
    expect(ledger.app_id).toBe(aliceApp.app.id);
    expect(ledger.environment_id).toBe(aliceApp.environment.id);
    expect(ledger.collection).toHaveLength(3);
    expect(JSON.stringify(ledger)).not.toContain(aliceCookie);
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

  it('removes archived projects from account inventory and denies direct reads and key creation', async () => {
    const created = await request('/v1/apps', aliceCookie, {
      name: 'Archived fixture',
      environment: 'production',
    });
    const project = (await created.json()) as typeof aliceApp;
    await env
      .DB!.prepare('UPDATE apps SET archived_at = 100 WHERE id = ?')
      .bind(project.app.id)
      .run();
    const listed = (await (await request('/v1/apps')).json()) as {
      apps: Array<{ app: { id: string } }>;
    };
    expect(listed.apps.some(({ app }) => app.id === project.app.id)).toBe(false);
    const identity = await accountIdentity(
      new Request('https://dashboard.example.com/v1/apps', {
        headers: { cookie: aliceCookie },
      }),
      env,
    );
    expect(identity?.owner.appIds).not.toContain(project.app.id);
    const query = `app_id=${project.app.id}&environment_id=${project.environment.id}`;
    expect((await request(`/v1/logs?${query}`)).status).toBe(403);
    expect(
      (
        await request('/v1/public-keys', aliceCookie, {
          app_id: project.app.id,
          environment_id: project.environment.id,
          allowed_origins: ['https://example.com'],
        })
      ).status,
    ).toBe(403);
  });

  it('revokes the actual session on sign-out', async () => {
    const created = await request('/v1/apps', bobCookie, {
      name: 'Bob revocation API',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as typeof aliceApp;
    const capabilitiesPath = `/v1/capabilities?app_id=${project.app.id}&environment_id=${project.environment.id}`;
    expect((await request(capabilitiesPath, bobCookie)).status).toBe(200);
    const beforeSignOut = await request('/v1/auth/get-session', bobCookie);
    expect(beforeSignOut.status).toBe(200);
    expect(await beforeSignOut.json()).toMatchObject({ user: { name: 'bob' } });

    const response = await request('/v1/auth/sign-out', bobCookie, {});
    expect(response.status).toBe(200);
    expect(await (await request('/v1/auth/get-session', bobCookie)).json()).toBeNull();
    expect((await request('/v1/apps', bobCookie)).status).toBe(401);
    expect((await request(capabilitiesPath, bobCookie)).status).toBe(401);
    await env
      .DB!.prepare('UPDATE apps SET archived_at = ? WHERE id = ?')
      .bind(Date.now(), project.app.id)
      .run();
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

  it('reads current verification state on every request and rejects expired sessions', async () => {
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
    expect((await request('/v1/apps', cookie)).status).toBe(200);
    const created = await request('/v1/apps', cookie, {
      name: 'Verification state API',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as typeof aliceApp;
    const capabilitiesPath = `/v1/capabilities?app_id=${project.app.id}&environment_id=${project.environment.id}`;
    expect((await request(capabilitiesPath, cookie)).status).toBe(200);
    await env.DB!.prepare('UPDATE "user" SET emailVerified = 0 WHERE id = ?').bind(user.id).run();
    expect((await request('/v1/apps', cookie)).status).toBe(401);
    expect((await request(capabilitiesPath, cookie)).status).toBe(401);
    await env.DB!.prepare('UPDATE "user" SET emailVerified = 1 WHERE id = ?').bind(user.id).run();
    expect((await request(capabilitiesPath, cookie)).status).toBe(200);
    await ctx.internalAdapter.updateSession(session.token, { expiresAt: new Date(0) });
    expect((await request('/v1/apps', cookie)).status).toBe(401);
    expect((await request(capabilitiesPath, cookie)).status).toBe(401);
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
