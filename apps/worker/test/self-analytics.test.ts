import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  recordProductMilestone,
  scheduleProductMilestone,
  selfAnalyticsConfig,
} from '../src/self-analytics.js';
import { personalWorkspace } from '../src/accounts.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

function fixture() {
  const sql = new DatabaseSync(':memory:');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  sql.exec(
    "INSERT INTO apps VALUES ('self', 'App Health', 1); INSERT INTO environments VALUES ('prod', 'self', 'production', 1)",
  );
  const db: D1DatabaseLike = {
    prepare(query: string) {
      let values: unknown[] = [];
      const statement = sql.prepare(query);
      return {
        bind(...args: unknown[]) {
          values = args;
          return this;
        },
        async first<T>() {
          return (statement.get(...(values as never[])) ?? null) as T | null;
        },
        async all<T>() {
          return { results: statement.all(...(values as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(values as never[]));
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      } as D1PreparedStatement;
    },
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return {
    sql,
    db,
    env: { DB: db, APP_HEALTH_SELF_APP_ID: 'self', APP_HEALTH_SELF_ENVIRONMENT_ID: 'prod' },
  };
}
afterEach(() => vi.restoreAllMocks());
it('stores only scoped milestone facts once on replay and marks the logs capability', async () => {
  const f = fixture();
  await Promise.all([
    recordProductMilestone(f.env, 'signup.completed', 'private-profile@example.test'),
    recordProductMilestone(f.env, 'signup.completed', 'private-profile@example.test'),
  ]);
  await recordProductMilestone(f.env, 'project.created', 'private-project-id');
  const rows = f.sql.prepare('SELECT * FROM log_events ORDER BY event').all();
  expect(rows).toHaveLength(2);
  expect(rows).toEqual([
    expect.objectContaining({
      app_id: 'self',
      environment_id: 'prod',
      event: 'project.created',
      source: 'server',
    }),
    expect.objectContaining({ event: 'signup.completed' }),
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private-profile|private-project|example.test/);
  expect(
    f.sql
      .prepare("SELECT first_received_at FROM environment_capabilities WHERE capability = 'logs'")
      .get(),
  ).not.toBeUndefined();
  await recordProductMilestone(
    { ...f.env, APP_HEALTH_SELF_APP_ID: 'wrong' },
    'project.created',
    'other',
  );
  expect(f.sql.prepare('SELECT * FROM log_events').all()).toHaveLength(2);
  f.sql.close();
});
it('does not break a product operation when telemetry is absent or fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await recordProductMilestone({}, 'project.created', 'one');
  const f = fixture();
  f.sql.close();
  const waits: Promise<unknown>[] = [];
  await scheduleProductMilestone(f.env, 'project.created', 'one', {
    waitUntil(promise) {
      waits.push(promise);
    },
  });
  await expect(Promise.all(waits)).resolves.toEqual([undefined]);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('self_analytics_delivery_failed'));
});
it('counts first workspace creation once, never a returning session', async () => {
  const f = fixture();
  f.sql
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
    )
    .run('user', 'Private name', 'private@test.example', 1, '2026-09-12', '2026-09-12');
  const created = vi.fn();
  const workspaces = await Promise.all(
    Array.from({ length: 3 }, () => personalWorkspace(f.db, 'user', created)),
  );
  expect(new Set(workspaces.map((row) => row.id)).size).toBe(1);
  expect(created).toHaveBeenCalledOnce();
  await personalWorkspace(f.db, 'user', created);
  expect(created).toHaveBeenCalledOnce();
  f.sql.close();
});
it('publishes only public configuration on the dashboard host', async () => {
  const env = {
    APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
    APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
    APP_HEALTH_SELF_PUBLIC_KEY: 'ahk_pub_test',
    OWNER_AUTH_TOKEN: 'never-expose',
  };
  const get = (host: string, method = 'GET') =>
    selfAnalyticsConfig(
      new Request(`https://${host}/v1/product-analytics/config`, { method }),
      env,
    )!;
  expect(await get('dashboard.test').json()).toEqual({
    publicKey: 'ahk_pub_test',
    ingestOrigin: 'https://ingest.test',
  });
  expect(get('ingest.test').status).toBe(404);
  expect(get('dashboard.test', 'POST').status).toBe(405);
  expect(selfAnalyticsConfig(new Request('https://dashboard.test/other'), env)).toBeNull();
  expect(
    await selfAnalyticsConfig(new Request('http://local/v1/product-analytics/config'), {
      APP_HEALTH_MODE: 'local',
    })!.json(),
  ).toBeNull();
});
