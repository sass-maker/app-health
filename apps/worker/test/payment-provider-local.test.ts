import { expect, it } from 'vitest';
import worker from '../src/index.js';
import type { PaymentConnection, PaymentImportJob } from '@app-health/contracts';
it.each(['stripe', 'polar', 'dodo'] as const)(
  '%s local fixture uses the actual worker API for routing, queued imports, resume, cancellation, reports and disconnect',
  async (provider) => {
    const request = (path: string, method = 'GET', body?: unknown) =>
      worker.fetch(
        new Request(`http://localhost${path}`, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        { APP_HEALTH_MODE: 'local' },
      );
    const created = (await (
      await request('/v1/apps', 'POST', { name: `Fixture ${provider}`, environment: 'local' })
    ).json()) as { app: { id: string }; environment: { id: string } };
    const scope = { app_id: created.app.id, environment_id: created.environment.id },
      query = new URLSearchParams(scope).toString();
    const call = (path: string, method = 'GET', body?: unknown) =>
      request(`${path}?${query}`, method, body);
    const list = await call('/v1/payment-connections');
    expect(await list.json()).toMatchObject({ fixture_mode: true, connections: [] });
    expect(
      (
        await call('/v1/payment-connections', 'POST', {
          ...scope,
          provider,
          mode: 'live',
          fixture: true,
        })
      ).status,
    ).toBe(400);
    const response = await call('/v1/payment-connections', 'POST', {
      ...scope,
      provider,
      mode: 'test',
      fixture: true,
    });
    expect(response.status).toBe(201);
    const c = (await response.json()) as PaymentConnection,
      base = `/v1/payment-connections/${c.id}`;
    expect(c).toMatchObject({ fixture: true, routing: 'exclusive' });
    expect((await call(base + '/verify', 'POST', {})).status).toBe(200);
    expect((await call(base)).status).toBe(200);
    expect((await call(base + '/routing', 'PUT', { routing: 'products', rules: [] })).status).toBe(
      200,
    );
    const start = async (kind = 'imports') => {
      const r = await call(base + '/' + kind, 'POST', { from: 0, to: Date.now() });
      expect(r.status).toBe(202);
      return (await r.json()) as PaymentImportJob;
    };
    const cancelled = await start();
    expect(
      (await (
        await call(`/v1/payment-imports/${cancelled.id}/cancel`, 'POST', {})
      ).json()) as PaymentImportJob,
    ).toMatchObject({ status: 'cancelled' });
    const job = await start();
    expect(job.status).toBe('queued');
    expect(await (await call(`/v1/payment-imports/${job.id}`)).json()).toMatchObject({
      status: 'paused',
      unresolved: 1,
      reason: 'unmapped_product_cart',
    });
    expect(
      (
        await call(base + '/routing', 'PUT', {
          routing: 'products',
          rules: [{ ...scope, product_id: 'fixture-product' }],
        })
      ).status,
    ).toBe(200);
    expect(
      await (await call(`/v1/payment-imports/${job.id}/resume`, 'POST', {})).json(),
    ).toMatchObject({ status: 'queued' });
    expect(await (await call(`/v1/payment-imports/${job.id}`)).json()).toMatchObject({
      status: 'finished',
      recorded: 2,
    });
    const reconcile = await start('reconcile');
    expect(await (await call(`/v1/payment-imports/${reconcile.id}`)).json()).toMatchObject({
      status: 'finished',
      recorded: 0,
    });
    const webhook = await start('fixture-webhook');
    expect(await (await call(`/v1/payment-imports/${webhook.id}`)).json()).toMatchObject({
      status: 'finished',
      recorded: 0,
    });
    expect(await (await call(base)).json()).toMatchObject({ webhook_at: expect.any(Number) });
    expect((await call(base + '/jobs')).status).toBe(200);
    const report = await request(
      `/v1/analytics/provider-revenue?${query}&from=${Date.now() - 86400000}&to=${Date.now()}&mode=test`,
    );
    expect(await report.json()).toMatchObject({
      basis: 'provider_object_created',
      totals: [{ gross_minor: 1200, refunds_minor: 200, net_minor: 1000 }],
    });
    const custom = await request(
      `/v1/analytics/revenue?${query}&from=${Date.now() - 86400000}&to=${Date.now()}&mode=test`,
    );
    expect(await custom.json()).toMatchObject({ totals: [] });
    expect(
      (await call(base + '/credentials', 'POST', { api_key: 'never-persist-me' })).status,
    ).toBe(400);
    expect((await call(base + '/credentials', 'POST', { fixture: true })).status).toBe(200);
    expect((await call(base, 'DELETE')).status).toBe(200);
    expect((await call(base + '/verify', 'POST', {})).status).toBe(409);
    expect((await request(base + '?app_id=foreign&environment_id=foreign')).status).toBe(403);
  },
);
