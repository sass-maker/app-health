import { expect, it } from 'vitest';
import { PaymentIngestV1 } from '@app-health/contracts';
import worker, { type Env } from '../src/index.js';
import { D1PaymentLedger } from '../src/payments-store.js';
import { createApiToken } from '../src/workspace-access.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';

it.each(['stripe', 'polar', 'dodo'] as const)(
  '%s MCP revenue uses the selected ledger with scoped read authorization',
  async (provider) => {
    const f = providerFixture(provider);
    try {
      const session = await f.session();
      await processProviderResource(
        f.db,
        session,
        'payment',
        String(f.payment.id ?? f.payment.payment_id),
      );
      await processProviderResource(
        f.db,
        session,
        'refund',
        String(f.refund.id ?? f.refund.refund_id),
      );
      await new D1PaymentLedger(f.db).record(
        PaymentIngestV1.parse({
          schema_version: 1,
          app_id: 'app',
          environment_id: 'env',
          namespace: { provider: 'custom', account_id: 'custom-merchant', mode: 'test' },
          delivery_id: 'custom-delivery',
          fact: {
            kind: 'payment',
            transaction_id: 'custom-payment',
            occurred_at: f.time,
            amount_minor: 2500,
            currency: 'USD',
          },
        }),
      );
      const token = await createApiToken(
        f.db,
        { id: 'user', label: 'Owner', workspaceId: 'ws', workspaceRole: 'owner' },
        { name: 'Report', permission: 'read', scopes: [{ app_id: 'app', environment_id: 'env' }] },
      );
      const env: Env = {
        DB: f.db,
        APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
        APP_HEALTH_INGEST_HOST: 'ingest.test',
        APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
        OWNER_AUTH_TOKEN: MASTER,
        CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
        TELEMETRY: { writeDataPoint() {} },
      };
      const call = async (patch: Record<string, unknown> = {}) => {
        const response = await worker.fetch(
          new Request('https://dashboard.test/mcp', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token.token}`,
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'revenue_report',
                arguments: {
                  app_id: 'app',
                  environment_id: 'env',
                  from: f.time - 1,
                  to: Date.now(),
                  mode: 'test',
                  ...patch,
                },
              },
            }),
          }),
          env,
        );
        expect(response.status).toBe(200);
        return (await response.json()) as {
          error?: { code: number };
          result: { isError: boolean; content: { text: string }[] };
        };
      };
      for (const args of [{ provider }, { basis: 'provider' }, { basis: 'provider', provider }]) {
        const result = (await call(args)).result;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          basis: 'provider_object_created',
          totals: [{ provider, gross_minor: 1000, refunds_minor: 200, net_minor: 800 }],
        });
      }
      for (const args of [{}, { basis: 'custom' }, { provider: 'custom' }]) {
        const result = (await call(args)).result;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          basis: 'recorded_cashflows',
          totals: [{ provider: 'custom', gross_minor: 2500, net_minor: 2500 }],
        });
      }
      for (const args of [{ mode: 'live' }, { currency: 'EUR' }, { account_id: 'foreign' }]) {
        const result = (await call({ provider, ...args })).result;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content[0].text)).toMatchObject({ totals: [] });
      }
      const forbidden = (await call({ provider, app_id: 'other-app', environment_id: 'other-env' }))
        .result;
      expect(forbidden.isError).toBe(true);
      expect(JSON.parse(forbidden.content[0].text)).toMatchObject({ error: expect.any(String) });
      for (const args of [
        { basis: 'unknown' },
        { basis: 'custom', provider },
        { basis: 'provider', provider: 'custom' },
      ])
        expect(await call(args)).toMatchObject({ error: { code: -32602 } });
    } finally {
      f.sqlite.close();
    }
  },
);
