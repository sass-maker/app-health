import { describe, expect, it, vi } from 'vitest';
import { RevenueReportV1, SEED_APP_ID, SEED_ENV_ID, SEED_KEY } from '@app-health/contracts';
import { handlePaymentIngest, handlePaymentOwner } from '../src/payments-routes.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import { AppHealthService } from '../src/service.js';
import worker from '../src/index.js';
import { analysisDatabase } from './analysis-sqlite.js';
import { paymentInput } from './payments-fixture.js';

async function fixture() {
  const repos = (await InMemoryAdapter.create()).asRepositories();
  const created = await new AppHealthService(repos).createApp(
    { name: 'Revenue', environment: 'production', key_scope: 'environment' },
    Date.now(),
  );
  const { sqlite, db } = analysisDatabase();
  sqlite
    .prepare('INSERT INTO apps(id, name, created_at) VALUES (?, ?, ?)')
    .run(created.app.id, 'Revenue', 1);
  sqlite
    .prepare('INSERT INTO environments(id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(created.environment.id, created.app.id, 'production', 1);
  sqlite.prepare('INSERT INTO workspace_apps VALUES (?, ?)').run(created.app.id, 'ws');
  const env = { DB: db, APP_HEALTH_INGEST_HOST: 'ingest.test' };
  const owner = { id: 'owner', label: 'Owner', appIds: [created.app.id] };
  const input = {
    ...paymentInput(),
    app_id: created.app.id,
    environment_id: created.environment.id,
  };
  const query = new URLSearchParams({
    app_id: created.app.id,
    environment_id: created.environment.id,
    from: '0',
    to: '1000',
  }).toString();
  const ingest = (body: unknown = input, headers: Record<string, string> = {}, local = false) =>
    handlePaymentIngest(
      new Request('https://ingest.test/v1/payments', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.key.key}`, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      env,
      repos,
      local,
    );
  const report = (patch = '', identity = owner, local = false) =>
    handlePaymentOwner(
      new Request(`https://dashboard.test/v1/analytics/revenue?${query}${patch}`),
      env,
      identity,
      repos,
      local,
    );
  return { repos, created, sqlite, db, env, owner, input, query, ingest, report };
}

describe('private financial ingestion and owner reports', () => {
  it('records authenticated server facts, deduplicates and serves scoped exact D1 reports', async () => {
    const f = await fixture();
    try {
      expect(await (await f.ingest())!.json()).toEqual({
        schema_version: 1,
        recorded: true,
        duplicate: false,
      });
      expect(await (await f.ingest())!.json()).toEqual({
        schema_version: 1,
        recorded: false,
        duplicate: true,
      });
      expect(
        (await f.ingest({ ...f.input, fact: { ...f.input.fact, amount_minor: 999 } }))!.status,
      ).toBe(409);
      const response = (await f.report())!;
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(RevenueReportV1.parse(await response.json())).toMatchObject({
        source: 'd1',
        totals: [{ gross_minor: 1000, payments: 1 }],
      });
      expect((await f.report('', { ...f.owner, appIds: [] }))!.status).toBe(403);
      expect((await f.report('&environment_id=other-env'))!.status).toBe(403);
      expect(
        (await f.report(
          '&mode=live&currency=USD&provider=custom&account_id=merchant&breakdown=page',
        ))!.status,
      ).toBe(200);
      expect(
        (await f.ingest({ ...f.input, namespace: { ...f.input.namespace, provider: 'stripe' } }))!
          .status,
      ).toBe(403);
      const key = await f.repos.keys.verifyKey(f.created.key.key);
      await f.repos.keys.revokeKey(key!.id, Date.now());
      expect((await f.ingest())!.status).toBe(401);
    } finally {
      f.sqlite.close();
    }
  });
  it('resolves environment-scoped and product-scoped keys without trusting body app/workspace identity', async () => {
    const f = await fixture();
    try {
      const second = await f.repos.environments.createEnvironment(
        f.created.app.id,
        'preview',
        Date.now(),
      );
      f.sqlite
        .prepare('INSERT INTO environments(id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
        .run(second.id, f.created.app.id, 'preview', 1);
      expect((await f.ingest({ ...f.input, environment_id: second.id }))!.status).toBe(403);
      expect((await f.ingest({ ...f.input, app_id: 'other-app' }))!.status).toBe(403);
      expect((await f.ingest({ ...f.input, environment_id: 'missing' }))!.status).toBe(403);
      expect((await f.ingest({ ...f.input, workspace_id: 'ws' }))!.status).toBe(400);
      const product = await f.repos.keys.createProductKey(f.created.app.id, Date.now());
      const headers = { authorization: `Bearer ${product.rawKey}` };
      expect((await f.ingest({ ...f.input, environment_id: second.id }, headers))!.status).toBe(
        202,
      );
      expect((await f.ingest({ ...f.input, environment_id: 'other-env' }, headers))!.status).toBe(
        403,
      );
      expect(
        (await handlePaymentOwner(
          new Request(`https://dashboard.test/v1/analytics/revenue?${f.query}`),
          f.env,
          { ...f.owner, workspaceId: 'foreign-workspace' },
          f.repos,
          false,
        ))!.status,
      ).toBe(403);
      expect(
        (await handlePaymentOwner(
          new Request(`https://dashboard.test/v1/analytics/revenue?${f.query}`),
          f.env,
          { ...f.owner, workspaceId: 'ws' },
          f.repos,
          false,
        ))!.status,
      ).toBe(200);
      expect(
        (await handlePaymentOwner(
          new Request(`https://dashboard.test/v1/analytics/revenue?${f.query}`),
          f.env,
          { ...f.owner, appId: 'other-app' },
          f.repos,
          false,
        ))!.status,
      ).toBe(403);
    } finally {
      f.sqlite.close();
    }
  });
  it('rejects browser origins, invalid/authless requests, oversized bodies and unsupported methods/hosts', async () => {
    const f = await fixture();
    try {
      expect((await f.ingest(f.input, { origin: 'https://product.test' }))!.status).toBe(403);
      for (const authorization of ['', 'Bearer ahk_pub_private-is-forbidden', 'Bearer missing'])
        expect((await f.ingest(f.input, { authorization }))!.status).toBe(401);
      expect((await f.ingest({}))!.status).toBe(400);
      expect((await f.ingest('{'))!.status).toBe(400);
      expect((await f.ingest('x'.repeat(16385)))!.status).toBe(413);
      expect(
        (await f.ingest({
          ...f.input,
          fact: { ...f.input.fact, occurred_at: Date.now() + 600000 },
        }))!.status,
      ).toBe(400);
      for (const path of [
        'https://wrong.test/v1/payments',
        'https://instance.workers.dev/v1/payments',
      ])
        expect((await handlePaymentIngest(new Request(path), f.env, f.repos, false))!.status).toBe(
          404,
        );
      expect(
        (await handlePaymentIngest(
          new Request('https://ingest.test/v1/payments'),
          f.env,
          f.repos,
          false,
        ))!.status,
      ).toBe(405);
      expect(
        await handlePaymentIngest(
          new Request('https://ingest.test/unrelated'),
          f.env,
          f.repos,
          false,
        ),
      ).toBeNull();
      expect(
        await handlePaymentOwner(
          new Request('https://dashboard.test/unrelated'),
          f.env,
          f.owner,
          f.repos,
          false,
        ),
      ).toBeNull();
      expect(
        (await handlePaymentOwner(
          new Request(`https://dashboard.test/v1/analytics/revenue?${f.query}`, { method: 'POST' }),
          f.env,
          f.owner,
          f.repos,
          false,
        ))!.status,
      ).toBe(405);
      expect((await f.report('&from=invalid'))!.status).toBe(400);
    } finally {
      f.sqlite.close();
    }
  });
  it('keeps local development credential-free and never falls back to it when durable storage is unavailable', async () => {
    const f = await fixture();
    try {
      expect((await f.ingest(f.input, {}, true))!.status).toBe(202);
      expect(
        RevenueReportV1.parse(await (await f.report('', f.owner, true))!.json()),
      ).toMatchObject({ source: 'local', coverage_note: expect.stringContaining('restart') });
      const request = new Request(`https://dashboard.test/v1/analytics/revenue?${f.query}`);
      expect((await handlePaymentOwner(request, {}, f.owner, f.repos, false))!.status).toBe(503);
      const batch = vi.spyOn(f.db, 'batch').mockRejectedValueOnce(new Error('sensitive error'));
      expect(await (await f.ingest())!.json()).toEqual({
        error: 'Financial ledger unavailable; no acceptance or totals are claimed',
      });
      batch.mockRestore();
    } finally {
      f.sqlite.close();
    }
  });
});

it('wires generic financial ingestion and owner revenue reports into the complete worker', async () => {
  const input = {
    ...paymentInput('index-integration'),
    app_id: SEED_APP_ID,
    environment_id: SEED_ENV_ID,
  };
  const env = { APP_HEALTH_MODE: 'local' };
  const response = await worker.fetch(
    new Request('https://local/v1/payments', {
      method: 'POST',
      headers: { authorization: `Bearer ${SEED_KEY}` },
      body: JSON.stringify(input),
    }),
    env,
  );
  expect(response.status).toBe(202);
  const query = new URLSearchParams({
    app_id: SEED_APP_ID,
    environment_id: SEED_ENV_ID,
    from: '0',
    to: '1000',
  });
  const report = await worker.fetch(
    new Request(`https://local/v1/analytics/revenue?${query}`),
    env,
  );
  expect(report.status).toBe(200);
  expect(RevenueReportV1.parse(await report.json()).totals).toEqual([
    expect.objectContaining({ payments: 1, gross_minor: 1000 }),
  ]);
});
