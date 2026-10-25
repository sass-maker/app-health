import worker from '../src/index.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleProviderWebhook } from '../src/payment-provider-webhooks.js';
import { drainProviderJob } from '../src/payment-provider-jobs.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';

function signed(
  provider: string,
  secret: string,
  body: Uint8Array,
  id = 'evt_1',
  scheme = 'standard',
): Record<string, string> {
  const time = String(Math.floor(Date.now() / 1000));
  if (provider === 'stripe')
    return {
      'stripe-signature': `t=${time},v1=${createHmac('sha256', secret).update(`${time}.`).update(body).digest('hex')}`,
    };
  const key =
    scheme === 'polar_legacy'
      ? Buffer.from(secret)
      : Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': time,
    'webhook-signature':
      'v1,' + createHmac('sha256', key).update(`${id}.${time}.`).update(body).digest('base64'),
  };
}
describe.each(['stripe', 'polar', 'dodo'] as const)('%s signed webhook durability', (provider) => {
  it('verifies raw bytes before parsing, retains minimal work, rejects delivery-body reuse and records import-compatible facts', async () => {
    const f = providerFixture(provider);
    try {
      if (provider !== 'stripe')
        f.credentials.webhook_secrets = [
          `whsec_${Buffer.from('synthetic-webhook-signing-key').toString('base64')}`,
        ];
      const c = await f.connect(),
        env = {
          DB: f.db,
          OWNER_AUTH_TOKEN: MASTER,
          APP_HEALTH_INGEST_HOST: 'ingest.test',
          APP_HEALTH_DASHBOARD_HOST: 'dashboard.test',
          APP_HEALTH_INGEST_ORIGIN: 'https://ingest.test',
          CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
          ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic',
          TELEMETRY: { writeDataPoint() {} },
        };
      const payload = {
        id: 'evt_1',
        type:
          provider === 'stripe'
            ? 'charge.succeeded'
            : provider === 'polar'
              ? 'order.paid'
              : 'payment.succeeded',
        livemode: false,
        data: provider === 'stripe' ? { object: f.payment } : f.payment,
        private: 'never persist this payload',
      };
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const call = (
        body: Uint8Array = bytes,
        headers = signed(provider, f.credentials.webhook_secrets[0], body),
      ) =>
        worker.fetch(
          new Request(`https://ingest.test/v1/payment-webhooks/${provider}/${c.id}`, {
            method: 'POST',
            headers,
            body,
          }),
          env,
        );
      expect((await call(bytes, {} as ReturnType<typeof signed>))!.status).toBe(401);
      expect(
        f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_provider_jobs').get(),
      ).toMatchObject({ n: 0 });
      const accepted = (await call())!;
      expect(accepted.status).toBe(202);
      const receipt = (await accepted.json()) as { job_id: string };
      const serialized = JSON.stringify(
        f.sqlite.prepare('SELECT * FROM payment_provider_jobs').all(),
      );
      expect(serialized).not.toContain('private@example');
      expect(serialized).not.toContain('never persist');
      expect(serialized).not.toContain('Newsletter');
      expect(await (await call())!.json()).toMatchObject({
        duplicate: true,
        job_id: receipt.job_id,
      });
      const mutated = new TextEncoder().encode(JSON.stringify({ ...payload, private: 'changed' }));
      expect((await call(mutated))!.status).toBe(409);
      expect(
        (await call(mutated, signed(provider, f.credentials.webhook_secrets[0], bytes)))!.status,
      ).toBe(401);
      await drainProviderJob(f.runtime, receipt.job_id);
      expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
        n: 1,
      });
      expect(f.sqlite.prepare('SELECT webhook_at FROM payment_connections').get()).toMatchObject({
        webhook_at: expect.any(Number),
      });
      const path = `https://ingest.test/v1/payment-webhooks/${provider}/${c.id}`;
      expect(
        (await handleProviderWebhook(
          new Request(path, {
            method: 'POST',
            headers: { origin: 'https://site.test' },
            body: bytes,
          }),
          env,
          false,
        ))!.status,
      ).toBe(403);
      expect((await handleProviderWebhook(new Request(path), env, false))!.status).toBe(405);
      expect(
        (await handleProviderWebhook(
          new Request(path.replace('ingest.test', 'wrong.test'), { method: 'POST', body: bytes }),
          env,
          false,
        ))!.status,
      ).toBe(404);
    } finally {
      f.sqlite.close();
    }
  });
});
it('supports explicit Polar legacy signing, rejects oversized/invalid signed JSON, and hashes distinct raw bytes', async () => {
  const f = providerFixture('polar');
  try {
    f.credentials.signature_scheme = 'polar_legacy';
    const c = await f.connect(),
      env = { DB: f.db, OWNER_AUTH_TOKEN: MASTER, APP_HEALTH_INGEST_HOST: 'ingest.test' };
    const call = (bytes: Uint8Array, id = 'legacy') =>
      handleProviderWebhook(
        new Request(`https://ingest.test/v1/payment-webhooks/polar/${c.id}`, {
          method: 'POST',
          headers: signed('polar', f.credentials.webhook_secrets[0], bytes, id, 'polar_legacy'),
          body: bytes,
        }),
        env,
        false,
      );
    expect((await call(new TextEncoder().encode('{')))!.status).toBe(400);
    expect((await call(new Uint8Array(262145)))!.status).toBe(413);
    const first = new TextEncoder().encode('{"type":"ignored","extra":"a"}');
    first[first.length - 3] = 255;
    const second = first.slice();
    second[second.length - 3] = 254;
    expect((await call(first, 'same-id'))!.status).toBe(202);
    expect((await call(second, 'same-id'))!.status).toBe(409);
  } finally {
    f.sqlite.close();
  }
});
