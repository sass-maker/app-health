import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SEED_APP_ID, SEED_ENV_ID, SEED_PUBLIC_KEY } from '@app-health/contracts';
import { handleAnalyticsShareOwner, handlePublicAnalytics } from '../src/analytics-share-routes.js';
import { handleBrowserIngest } from '../src/browser-routes.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';
import type { BrowserEnvironment } from '../src/browser-routes.js';
import type { OwnerIdentity } from '../src/identity.js';

const owner: OwnerIdentity = { id: 'owner', label: 'Owner' };
const scopeQuery = `app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}`;

class SQLiteD1 implements D1DatabaseLike {
  constructor(private readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    const db = this.sqlite;
    const statement = db.prepare(query);
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) {
        values = next;
        return this;
      },
      async first<T>() {
        return (statement.get(...(values as never[])) as T | undefined) ?? null;
      },
      async all<T>() {
        return { results: statement.all(...(values as never[])) as T[] };
      },
      async run(): Promise<D1RunResult> {
        statement.run(...(values as never[]));
        const row = db.prepare('SELECT changes() AS count').get() as { count: number };
        return { success: true, meta: { changes: row.count } };
      },
    } as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

async function localFixture() {
  const adapter = await InMemoryAdapter.create();
  return { repos: adapter.asRepositories(), env: {} as BrowserEnvironment };
}

function ownerRequest(
  method: string,
  query = scopeQuery,
  origin?: string,
  body?: unknown,
): Request {
  const headers = origin ? { origin } : undefined;
  return new Request(`http://localhost/v1/analytics/shares?${query}`, {
    method,
    headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createLocalShare() {
  const fixture = await localFixture();
  const response = await handleAnalyticsShareOwner(
    ownerRequest('POST'),
    fixture.env,
    owner,
    fixture.repos,
    true,
  );
  return { ...fixture, body: (await response!.json()) as { share: { id: string }; token: string } };
}

describe('analytics share owner boundary', () => {
  it('permits anonymous aggregate CORS reads only, including revoked replies', async () => {
    const fixture = await localFixture();
    for (const method of ['OPTIONS', 'GET', 'POST']) {
      const response = await handlePublicAnalytics(
        new Request('https://dashboard.test/v1/shared/analytics', {
          method,
          headers: {
            origin: 'https://product.test',
            'access-control-request-method': 'GET',
            'access-control-request-headers': 'authorization',
          },
        }),
        fixture.env,
        fixture.repos,
        true,
      );
      expect(response?.status).toBe(method === 'OPTIONS' ? 204 : method === 'GET' ? 404 : 405);
      expect(response?.headers.get('access-control-allow-origin')).toBe('*');
      expect(response?.headers.get('access-control-allow-credentials')).toBeNull();
      expect(response?.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    }
    const ownerReply = await handleAnalyticsShareOwner(
      ownerRequest('POST', scopeQuery, 'https://product.test'),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
    expect(ownerReply?.status).toBe(403);
    expect(ownerReply?.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('creates and lists scoped metadata while keeping the token out of listings', async () => {
    const fixture = await createLocalShare();
    expect(fixture.body.token).toMatch(/^ahs_/);
    const listed = await handleAnalyticsShareOwner(
      ownerRequest('GET'),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
    const payload = (await listed!.json()) as { shares: Record<string, unknown>[] };
    expect(payload.shares).toHaveLength(1);
    expect(payload.shares[0]).toMatchObject({ app_id: SEED_APP_ID, environment_id: SEED_ENV_ID });
    expect(JSON.stringify(payload)).not.toContain(fixture.body.token);
    await handleAnalyticsShareOwner(
      ownerRequest('DELETE', `${scopeQuery}&id=${fixture.body.share.id}`),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
  });

  it('defaults to aggregate sharing and supports scoped breakdown opt-in', async () => {
    const fixture = await localFixture();
    const created = await handleAnalyticsShareOwner(
      ownerRequest('POST'),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
    const body = (await created!.json()) as { share: Record<string, unknown>; token: string };
    expect(body.share.include_breakdowns).toBe(false);
    const opted = await handleAnalyticsShareOwner(
      ownerRequest('POST', scopeQuery, undefined, { include_breakdowns: true }),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
    const optedBody = (await opted!.json()) as { share: Record<string, unknown>; token: string };
    expect(optedBody.share.include_breakdowns).toBe(true);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('PATCH', `${scopeQuery}&id=${body.share.id}`, undefined, {
          include_breakdowns: true,
        }),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(200);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('GET', scopeQuery),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(200);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('PATCH', `${scopeQuery}&id=${body.share.id}`, undefined, {
          include_breakdowns: false,
        }),
        fixture.env,
        { ...owner, appIds: ['other'] },
        fixture.repos,
        true,
      ))!.status,
    ).toBe(403);
    await handleAnalyticsShareOwner(
      ownerRequest('DELETE', `${scopeQuery}&id=${body.share.id}`),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
    await handleAnalyticsShareOwner(
      ownerRequest('DELETE', `${scopeQuery}&id=${optedBody.share.id}`),
      fixture.env,
      owner,
      fixture.repos,
      true,
    );
  });

  it('denies foreign projects, product-scoped owners, foreign origins, and unsupported methods', async () => {
    const fixture = await localFixture();
    const foreign = { ...owner, appIds: ['some-other-app'] };
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(
        (await handleAnalyticsShareOwner(
          ownerRequest(method),
          fixture.env,
          foreign,
          fixture.repos,
          true,
        ))!.status,
      ).toBe(403);
    }
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('POST'),
        fixture.env,
        { ...owner, appId: SEED_APP_ID },
        fixture.repos,
        true,
      ))!.status,
    ).toBe(403);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('POST', scopeQuery, 'https://evil.example'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(403);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('PUT'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(405);
  });

  it('does not fall back when app or environment is missing', async () => {
    const fixture = await localFixture();
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('POST', 'app_id=missing-app&environment_id=missing-env'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(404);
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('POST', 'app_id=' + SEED_APP_ID + '&environment_id=missing-env'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(404);
  });

  it('maps the active-link cap to a conflict response', async () => {
    const fixture = await localFixture();
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await handleAnalyticsShareOwner(
        ownerRequest('POST'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      );
      expect(response!.status).toBe(201);
      created.push(((await response!.json()) as { share: { id: string } }).share.id);
    }
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('POST'),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(409);
    for (const id of created)
      await handleAnalyticsShareOwner(
        ownerRequest('DELETE', `${scopeQuery}&id=${id}`),
        fixture.env,
        owner,
        fixture.repos,
        true,
      );
  });
});

describe('public analytics share boundary', () => {
  it('serves only aggregate metrics and checks revocation on every read', async () => {
    const fixture = await createLocalShare();
    const batch = {
      schema_version: 1,
      batch_id: crypto.randomUUID(),
      session_id: crypto.randomUUID(),
      public_key: SEED_PUBLIC_KEY,
      events: [
        {
          event_id: crypto.randomUUID(),
          timestamp: Date.now(),
          type: 'pageview',
          path: '/private',
        },
      ],
    };
    expect(
      (await handleBrowserIngest(
        new Request('http://localhost/v1/browser', {
          method: 'POST',
          headers: { origin: 'http://localhost:5173' },
          body: JSON.stringify(batch),
        }),
        fixture.env,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(202);
    const publicRequest = () =>
      new Request(`http://localhost/v1/shared/analytics`, {
        headers: { authorization: `Bearer ${fixture.body.token}` },
      });
    const warm = await handlePublicAnalytics(publicRequest(), fixture.env, fixture.repos, true);
    expect(warm!.status).toBe(200);
    const body = JSON.stringify(await warm!.json());
    for (const secret of ['"events"', '/private', 'session_id', batch.session_id])
      expect(body).not.toContain(secret);
    expect(body).toContain('traffic');
    expect(
      (await handleAnalyticsShareOwner(
        ownerRequest('DELETE', `${scopeQuery}&id=${fixture.body.share.id}`),
        fixture.env,
        owner,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(200);
    expect(
      (await handlePublicAnalytics(publicRequest(), fixture.env, fixture.repos, true))!.status,
    ).toBe(404);
  });

  it('returns 404 for malformed and unknown links and 405 for unsupported methods', async () => {
    const fixture = await localFixture();
    const request = (token: string, method = 'GET') =>
      new Request('http://localhost/v1/shared/analytics', {
        method,
        headers: { authorization: `Bearer ${token}` },
      });
    expect(
      (await handlePublicAnalytics(request('ahk_bad'), fixture.env, fixture.repos, true))!.status,
    ).toBe(404);
    expect(
      (await handlePublicAnalytics(
        request('ahs_' + 'a'.repeat(43)),
        fixture.env,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(404);
    expect(
      (await handlePublicAnalytics(
        request('ahs_' + 'a'.repeat(43), 'POST'),
        fixture.env,
        fixture.repos,
        true,
      ))!.status,
    ).toBe(405);
  });
});

describe('production D1 ownership check', () => {
  it('creates through D1 and invalidates a link after ownership moves', async () => {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of ['0009_analytics_shares.sql', '0012_analytics_share_breakdowns.sql'])
      sqlite.exec(
        await readFile(
          join(dirname(fileURLToPath(import.meta.url)), '../migrations', file),
          'utf8',
        ),
      );
    sqlite.exec(
      'CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    sqlite.exec(
      'CREATE TABLE environments (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    sqlite.prepare('INSERT INTO apps VALUES (?, ?, ?)').run(SEED_APP_ID, 'demo-app', Date.now());
    sqlite
      .prepare('INSERT INTO environments VALUES (?, ?, ?, ?)')
      .run(SEED_ENV_ID, SEED_APP_ID, 'prod', Date.now());
    sqlite.exec(
      'CREATE TABLE workspace_apps (app_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)',
    );
    sqlite.prepare('INSERT INTO workspace_apps VALUES (?, ?)').run(SEED_APP_ID, 'workspace-one');
    const adapter = await InMemoryAdapter.create();
    const db = new SQLiteD1(sqlite);
    const env = { DB: db } as BrowserEnvironment;
    const created = await handleAnalyticsShareOwner(
      new Request(`https://dashboard.example/v1/analytics/shares?${scopeQuery}`, {
        method: 'POST',
      }),
      env,
      { ...owner, workspaceId: 'workspace-one', appIds: [SEED_APP_ID] },
      adapter.asRepositories(),
      false,
    );
    expect(created!.status).toBe(201);
    const token = ((await created!.json()) as { token: string }).token;
    sqlite
      .prepare('UPDATE workspace_apps SET workspace_id = ? WHERE app_id = ?')
      .run('workspace-two', SEED_APP_ID);
    expect(
      (await handlePublicAnalytics(
        new Request('https://dashboard.example/v1/shared/analytics', {
          headers: { authorization: `Bearer ${token}` },
        }),
        env,
        adapter.asRepositories(),
        false,
      ))!.status,
    ).toBe(404);
    sqlite.close();
  });
});
