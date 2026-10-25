import { describe, expect, it } from 'vitest';
import { PaymentCredentials, PaymentConnectionInput } from '@app-health/contracts';
import {
  normalizeProviderResource,
  providerMinorAmount,
  providerAttribution,
} from '../src/payment-provider-normalize.js';
import {
  sealProviderCredentials,
  openProviderCredentials,
} from '../src/payment-provider-crypto.js';
import { processProviderResource } from '../src/payment-provider-process.js';
import { providerRevenueReport } from '../src/payment-provider-report.js';
import { D1PaymentLedger } from '../src/payments-store.js';
import { providerFixture, MASTER } from './payment-provider-fixture.js';

const query = (from: number) => ({
  app_id: 'app',
  environment_id: 'env',
  from,
  to: Date.now(),
  breakdown: 'source' as const,
});
describe.each(['stripe', 'polar', 'dodo'] as const)(
  '%s canonical financial workflow',
  (provider) => {
    it('records independent payment/refund identities once, enriches attribution without modifying financial facts, isolates bases', async () => {
      const f = providerFixture(provider);
      try {
        const session = await f.session();
        const id = String(f.payment.id ?? f.payment.payment_id),
          refund = String(f.refund.id ?? f.refund.refund_id);
        expect(await processProviderResource(f.db, session, 'refund', refund)).toMatchObject({
          recorded: 1,
          unresolved: 0,
        });
        session.requests = 0;
        expect(await processProviderResource(f.db, session, 'payment', id)).toMatchObject({
          recorded: 0,
        });
        session.requests = 0;
        expect(await processProviderResource(f.db, session, 'refund', refund)).toMatchObject({
          recorded: 0,
        });
        let report = await providerRevenueReport(f.db, query(f.time - 1));
        expect(report).toMatchObject({
          basis: 'provider_object_created',
          totals: [
            {
              gross_minor: 1000,
              refunds_minor: 200,
              net_minor: 800,
              payments: 1,
              refunds: 1,
              attributed_payments: 1,
            },
          ],
          dimensions: [{ value: 'Newsletter', net_minor: 800 }],
        });
        expect((await new D1PaymentLedger(f.db).report(query(f.time - 1))).totals).toEqual([]);
        const before = f.sqlite.prepare('SELECT fact_hash FROM payment_facts ORDER BY kind').all();
        f.payment.metadata = {
          app_health_source: 'Partner',
          app_health_page: '/pricing',
          email: 'secret@example.test',
        };
        session.requests = 0;
        await processProviderResource(f.db, session, 'payment', id);
        report = await providerRevenueReport(f.db, query(f.time - 1));
        expect(report.dimensions[0].value).toBe('Partner');
        expect(f.sqlite.prepare('SELECT fact_hash FROM payment_facts ORDER BY kind').all()).toEqual(
          before,
        );
        expect(
          f.sqlite.prepare('SELECT source,page,country,campaign FROM payment_facts').all(),
        ).toEqual([
          expect.objectContaining({ source: null, page: null, country: null, campaign: null }),
          expect.objectContaining({ source: null, page: null, country: null, campaign: null }),
        ]);
        const persisted = JSON.stringify(
          f.sqlite.prepare('SELECT * FROM payment_provider_objects').all(),
        );
        expect(persisted).not.toContain('secret@example');
        expect(persisted).not.toContain('Private Person');
        expect(
          (await providerRevenueReport(f.db, { ...query(f.time + 500), from: f.time + 500 }))
            .totals[0],
        ).toMatchObject({ gross_minor: 0, net_minor: -200 });
      } finally {
        f.sqlite.close();
      }
    });
    it('retains immutable amount, currency and creation date and rejects over-refunds', async () => {
      const f = providerFixture(provider);
      try {
        const session = await f.session(),
          id = String(f.payment.id ?? f.payment.payment_id);
        await processProviderResource(f.db, session, 'payment', id);
        const field = provider === 'stripe' ? 'amount_captured' : 'total_amount';
        f.payment[field] = 999;
        session.requests = 0;
        expect(await processProviderResource(f.db, session, 'payment', id)).toMatchObject({
          unresolved: 1,
        });
        f.payment[field] = 1000;
        const created = provider === 'stripe' ? 'created' : 'created_at',
          original = f.payment[created];
        f.payment[created] =
          provider === 'stripe' ? Number(original) + 1 : new Date(f.time + 1000).toISOString();
        session.requests = 0;
        expect(await processProviderResource(f.db, session, 'payment', id)).toMatchObject({
          unresolved: 1,
        });
        f.payment[created] = original;
        f.payment.currency = 'eur';
        session.requests = 0;
        expect(await processProviderResource(f.db, session, 'payment', id)).toMatchObject({
          unresolved: 1,
        });
        f.payment.currency = 'usd';
        f.refund.amount = 1200;
        session.requests = 0;
        expect(
          await processProviderResource(
            f.db,
            session,
            'refund',
            String(f.refund.id ?? f.refund.refund_id),
          ),
        ).toMatchObject({ unresolved: 1 });
        expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
          n: 1,
        });
      } finally {
        f.sqlite.close();
      }
    });
  },
);
it('normalizes official Stripe special currency units without division rounding', () => {
  for (const code of ['ISK', 'UGX']) {
    expect(providerMinorAmount('stripe', 12300, code)).toBe(123);
    expect(() => providerMinorAmount('stripe', 12301, code)).toThrow('fractional');
  }
  expect(providerMinorAmount('stripe', 12, 'MGA')).toBe(1200);
  expect(providerMinorAmount('stripe', 123, 'JPY')).toBe(123);
  expect(providerMinorAmount('dodo', 123, 'KWD')).toBe(123);
  expect(providerMinorAmount('polar', 123, 'JPY')).toBe(123);
  expect(() => providerMinorAmount('polar', 123, 'KWD')).toThrow('unsupported');
  for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER])
    expect(() => providerMinorAmount('stripe', amount, 'USD')).toThrow();
  expect(() => providerMinorAmount('stripe', 1, 'XYZ')).toThrow();
});
it('accepts official Stripe refund shapes without livemode and excludes authorization releases', async () => {
  const f = providerFixture();
  try {
    const c = await f.connect();
    expect(f.refund).not.toHaveProperty('livemode');
    expect(normalizeProviderResource(c, f.refund, 'refund').reason).toBeNull();
    f.refund.reason = 'expired_uncaptured_charge';
    expect(normalizeProviderResource(c, f.refund, 'refund').reason).toContain(
      'authorization_release',
    );
    f.payment.captured = false;
    expect(normalizeProviderResource(c, f.payment, 'payment').reason).toContain('multicapture');
    f.payment.captured = true;
    f.payment.amount_captured = 0;
    expect(normalizeProviderResource(c, f.payment, 'payment').reason).toBe(
      'stripe_no_captured_purchase',
    );
    f.payment.amount_captured = 700;
    expect(normalizeProviderResource(c, f.payment, 'payment').amount).toBe(700);
  } finally {
    f.sqlite.close();
  }
});
it('keeps nullable Dodo refund facts and nonpaid states unresolved and rejects account/mode confusion', async () => {
  const f = providerFixture('dodo');
  try {
    const c = await f.connect();
    f.refund.amount = null;
    expect(normalizeProviderResource(c, f.refund, 'refund').reason).not.toBeNull();
    f.payment.status = 'partially_captured';
    expect(normalizeProviderResource(c, f.payment, 'payment').reason).toContain('partial_capture');
    f.payment.business_id = 'other';
    expect(() => normalizeProviderResource(c, f.payment, 'payment')).toThrow('account');
  } finally {
    f.sqlite.close();
  }
  const s = providerFixture();
  try {
    const c = await s.connect();
    s.payment.livemode = true;
    expect(() => normalizeProviderResource(c, s.payment, 'payment')).toThrow('mode');
  } finally {
    s.sqlite.close();
  }
});
it('retains only bounded explicit allowlisted attribution', () => {
  expect(
    providerAttribution({
      app_health_source: 'Partner',
      app_health_page: '/pricing',
      app_health_country: 'US',
      app_health_campaign: 'Launch',
      email: 'private',
    }),
  ).toEqual({ source: 'Partner', page: '/pricing', country: 'US', campaign: 'Launch' });
  expect(
    providerAttribution({
      app_health_page: '/user?email=a',
      app_health_country: 'usa',
      app_health_source: 'x'.repeat(101),
    }),
  ).toEqual({});
});
it('authenticates every immutable encryption scope field, limits encoded secrets, and fails closed', async () => {
  const f = providerFixture();
  try {
    const scope = await f.connect();
    const cipher = await sealProviderCredentials(MASTER, scope, f.credentials);
    expect(cipher).not.toContain(f.credentials.api_key);
    expect(await openProviderCredentials(MASTER, scope, cipher)).toEqual(f.credentials);
    for (const field of [
      'id',
      'workspace_id',
      'app_id',
      'environment_id',
      'provider',
      'account_id',
      'mode',
      'selector',
      'generation',
    ] as const) {
      const changed = { ...scope, [field]: field === 'generation' ? 2 : 'different' };
      await expect(
        openProviderCredentials(MASTER, changed as typeof scope, cipher),
      ).rejects.toThrow('unavailable');
    }
    await expect(
      openProviderCredentials('another-master-with-at-least-32-characters', scope, cipher),
    ).rejects.toThrow('unavailable');
    await expect(
      openProviderCredentials(MASTER, scope, cipher.replace('"v":2', '"v":1')),
    ).rejects.toThrow('unavailable');
    await expect(sealProviderCredentials('', scope, f.credentials)).rejects.toThrow('keyring');
    const large = {
      api_key: '"'.repeat(4096),
      webhook_secrets: Array(4).fill('"'.repeat(4096)),
      signature_scheme: 'standard' as const,
    };
    await expect(sealProviderCredentials(MASTER, scope, large)).rejects.toThrow('encoded_limit');
    for (const api_key of ['key\r\nInjected: value', 'unicode-密钥123456'])
      expect(PaymentCredentials.safeParse({ ...f.credentials, api_key }).success).toBe(false);
    expect(PaymentConnectionInput.safeParse({ ...f.input, unknown: 'identity' }).success).toBe(
      false,
    );
  } finally {
    f.sqlite.close();
  }
});

it('maps Polar payment and tax-inclusive refunds using the pinned presentment currency factors', async () => {
  const f = providerFixture('polar');
  try {
    const c = await f.connect();
    for (const [currency, raw, expected] of [
      ['JPY', 123, 123],
      ['ISK', 12300, 123],
      ['UGX', 12300, 123],
      ['MGA', 123, 12300],
    ] as const) {
      expect(
        normalizeProviderResource(c, { ...f.payment, total_amount: raw, currency }, 'payment'),
      ).toMatchObject({ amount: expected, reason: null });
      expect(
        normalizeProviderResource(
          c,
          { ...f.refund, amount: raw, tax_amount: 0, currency },
          'refund',
        ),
      ).toMatchObject({ amount: expected, reason: null });
    }
    expect(
      normalizeProviderResource(
        c,
        { ...f.refund, amount: 12301, tax_amount: 0, currency: 'ISK' },
        'refund',
      ).reason,
    ).toContain('fractional');
  } finally {
    f.sqlite.close();
  }
});
it('filters unresolved diagnostics by namespace and currency and labels unknown units explicitly', async () => {
  const f = providerFixture();
  try {
    const session = await f.session();
    f.payment.captured = false;
    await processProviderResource(f.db, session, 'payment', 'ch_1');
    const base = {
      ...query(0),
      provider: 'stripe' as const,
      account_id: f.account,
      mode: 'test' as const,
      currency: 'USD',
    };
    expect((await providerRevenueReport(f.db, base)).unresolved).toHaveLength(1);
    for (const filter of [
      { provider: 'polar' as const },
      { account_id: 'another' },
      { mode: 'live' as const },
      { currency: 'EUR' },
    ])
      expect((await providerRevenueReport(f.db, { ...base, ...filter })).unresolved).toEqual([]);
    f.payments.push({ ...f.payment, id: 'ch_unknown', currency: null });
    session.requests = 0;
    await processProviderResource(f.db, session, 'payment', 'ch_unknown');
    expect(
      (await providerRevenueReport(f.db, base)).unresolved.some((row) =>
        row.reason.startsWith('unknown_currency_'),
      ),
    ).toBe(true);
  } finally {
    f.sqlite.close();
  }
});
