import { expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { createApiToken } from '../src/workspace-access.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';

function environment(db: Env['DB']): Env {
  return {
    DB: db,
    APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
    APP_HEALTH_INGEST_HOST: 'ingest.test',
    APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
    OWNER_AUTH_TOKEN: MASTER,
    PAYMENT_ENCRYPTION_KEYRING: MASTER,
    BROWSER_EVENTS: { send: async () => {} },
    CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
    TELEMETRY: { writeDataPoint() {} },
  };
}
it('serves real production worker connection/import controls with encrypted secrets and denies origin/config confusion', async () => {
  const f = providerFixture();
  vi.stubGlobal('fetch', f.runtime.fetcher);
  try {
    const env = environment(f.db);
    const request = (path: string, method = 'GET', body?: unknown) =>
      worker.fetch(
        new Request(`https://dashboard.test${path}`, {
          method,
          headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
    const created = await request('/v1/apps', 'POST', {
      name: 'Provider boundary',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const project = (await created.json()) as { app: { id: string }; environment: { id: string } };
    const query = `app_id=${project.app.id}&environment_id=${project.environment.id}`;
    const result = await request(`/v1/payment-connections?${query}`, 'POST', {
      ...f.input,
      app_id: project.app.id,
      environment_id: project.environment.id,
    });
    expect(result.status).toBe(201);
    const c = (await result.json()) as { id: string };
    expect(JSON.stringify(c)).not.toContain(f.credentials.api_key);
    expect(
      JSON.stringify(f.sqlite.prepare('SELECT cipher FROM payment_connections').all()),
    ).not.toContain(f.credentials.api_key);
    expect(
      (await request(`/v1/payment-connections/${c.id}/verify?${query}`, 'POST', {})).status,
    ).toBe(200);
    const job = await request(`/v1/payment-connections/${c.id}/imports?${query}`, 'POST', {
      from: f.time - 1,
      to: Date.now(),
    });
    expect(job.status).toBe(202);
    const state = (await job.json()) as { id: string };
    expect(
      (await request(`/v1/payment-imports/${state.id}/cancel?${query}`, 'POST', {})).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/v1/payment-connections/${c.id}?app_id=other-app&environment_id=other-env`,
          'DELETE',
        )
      ).status,
    ).toBe(403);
    expect((await request(`/v1/payment-connections/${c.id}?${query}`, 'DELETE')).status).toBe(200);
    expect(
      (await request(`/v1/payment-connections/${c.id}/verify?${query}`, 'POST', {})).status,
    ).toBe(409);
  } finally {
    vi.unstubAllGlobals();
    f.sqlite.close();
  }
});
it('permits scoped API tokens to read provider reports but never connection configuration or import controls', async () => {
  const f = providerFixture();
  try {
    const session = await f.session();
    await processProviderResource(f.db, session, 'payment', 'ch_1');
    const token = await createApiToken(
      f.db,
      { id: 'user', label: 'Owner', workspaceId: 'ws', workspaceRole: 'owner' },
      { name: 'Report', permission: 'manage', scopes: [{ app_id: 'app', environment_id: 'env' }] },
    );
    const env = {
        ...environment(f.db),
        PAYMENT_ENCRYPTION_KEYRING: undefined,
        OWNER_AUTH_TOKEN: 'rotated-independent-owner-token',
      },
      query = `app_id=app&environment_id=env`;
    const call = (path: string, method = 'GET') =>
      worker.fetch(
        new Request(`https://dashboard.test${path}`, {
          method,
          headers: { authorization: `Bearer ${token.token}` },
          ...(method === 'GET' ? {} : { body: '{}' }),
        }),
        env,
      );
    const response = await call(
      `/v1/analytics/provider-revenue?${query}&from=${f.time - 1}&to=${Date.now()}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      basis: 'provider_object_created',
      totals: [{ gross_minor: 1000 }],
    });
    for (const path of [
      `/v1/payment-connections?${query}`,
      `/v1/payment-connections/${session.connection.id}/verify?${query}`,
      `/v1/payment-connections/${session.connection.id}/imports?${query}`,
    ])
      expect(
        (await call(path, path.includes('/verify') || path.includes('/imports') ? 'POST' : 'GET'))
          .status,
      ).toBe(403);
    expect(
      (
        await call(
          `/v1/analytics/provider-revenue?${query}&environment_id=other-env&from=0&to=1000`,
        )
      ).status,
    ).toBe(403);
  } finally {
    f.sqlite.close();
  }
});
