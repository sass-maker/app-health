import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PaymentIngestV1 } from '@app-health/contracts';
import { D1PaymentLedger } from '../src/payments-store.js';
import { LocalPaymentLedger } from '../src/payments-local.js';
import { PaymentCapacityError, PaymentConflictError } from '../src/payments-model.js';
import { paymentReport } from '../src/payments-report.js';
import { analysisDatabase } from './analysis-sqlite.js';
import { paymentInput, paymentQuery } from './payments-fixture.js';

describe.each(['d1', 'local'] as const)('%s financial ledger', (kind) => {
  async function fixture() {
    const database = analysisDatabase();
    const store = kind === 'd1' ? new D1PaymentLedger(database.db) : new LocalPaymentLedger();
    return { store, ...database };
  }
  it('deduplicates deliveries and canonical identities, with atomic conflicts and multiple partial refunds', async () => {
    const { store, sqlite } = await fixture();
    try {
      const original = paymentInput('txn', {
        attribution: { source: 'X', page: '/pricing', country: 'US', campaign: 'launch' },
      });
      expect(await store.record(original)).toBe(true);
      expect(await store.record(original)).toBe(false);
      expect(await store.record({ ...original, delivery_id: 'history-import' })).toBe(false);
      for (const amount_minor of [200, 300])
        expect(
          await store.record(
            paymentInput('txn', {
              kind: 'refund',
              refund_id: `refund-${amount_minor}`,
              amount_minor,
            }),
          ),
        ).toBe(true);
      expect(
        await store.record(
          paymentInput('txn', { kind: 'refund', refund_id: 'refund-200', amount_minor: 200 }),
        ),
      ).toBe(false);
      for (const patch of [
        { amount_minor: 999 },
        { currency: 'EUR' },
        { attribution: { source: 'Changed' } },
        { occurred_at: 101 },
      ])
        await expect(
          store.record({
            ...original,
            delivery_id: `conflict-${Object.keys(patch)[0]}`,
            fact: { ...original.fact, ...patch },
          } as PaymentIngestV1),
        ).rejects.toBeInstanceOf(PaymentConflictError);
      await expect(
        store.record(paymentInput('txn', { kind: 'refund', refund_id: 'over', amount_minor: 501 })),
      ).rejects.toBeInstanceOf(PaymentConflictError);
      await expect(
        store.record(
          paymentInput('txn', {
            kind: 'refund',
            refund_id: 'wrong-currency',
            currency: 'EUR',
            amount_minor: 1,
          }),
        ),
      ).rejects.toBeInstanceOf(PaymentConflictError);
      const report = await store.report(paymentQuery());
      expect(report.totals).toEqual([
        expect.objectContaining({
          gross_minor: 1000,
          refunds_minor: 500,
          net_minor: 500,
          payments: 1,
          refunds: 2,
          attributed_payments: 1,
        }),
      ]);
      for (const [breakdown, value] of Object.entries({
        source: 'X',
        page: '/pricing',
        country: 'US',
        campaign: 'launch',
      }))
        expect((await store.report(paymentQuery({ breakdown }))).dimensions).toEqual([
          expect.objectContaining({ value, net_minor: 500 }),
        ]);
      if (kind === 'd1') {
        expect(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({
          n: 3,
        });
        expect(
          sqlite
            .prepare(
              "SELECT COUNT(*) AS n FROM payment_deliveries WHERE delivery_id LIKE 'conflict-%'",
            )
            .get(),
        ).toMatchObject({ n: 0 });
      }
    } finally {
      sqlite.close();
    }
  });
  it('retains refund-first facts and uses refund time with original attribution after reconciliation', async () => {
    const { store, sqlite } = await fixture();
    try {
      const refund = paymentInput('later', {
        kind: 'refund',
        refund_id: 'refund',
        occurred_at: 300,
        amount_minor: 250,
      });
      expect(await store.record(refund)).toBe(true);
      expect((await store.report(paymentQuery())).totals).toEqual([
        expect.objectContaining({
          net_minor: 0,
          refunds: 0,
          pending_refunds: 1,
          pending_refunds_minor: 250,
        }),
      ]);
      for (const patch of [{ amount_minor: 249 }, { currency: 'EUR' }])
        await expect(store.record(paymentInput('later', patch))).rejects.toBeInstanceOf(
          PaymentConflictError,
        );
      expect(
        await store.record(paymentInput('later', { attribution: { source: 'Newsletter' } })),
      ).toBe(true);
      const report = await store.report(paymentQuery({ from: 200, to: 400 }));
      expect(report).toMatchObject({
        basis: 'recorded_cashflows',
        totals: [{ gross_minor: 0, refunds_minor: 250, net_minor: -250, pending_refunds: 0 }],
        dimensions: [{ value: 'Newsletter', net_minor: -250 }],
      });
      expect(await store.report(paymentQuery({ to: 100 }))).toMatchObject({ totals: [] });
    } finally {
      sqlite.close();
    }
  });
  it('isolates account/provider/mode/currency/project/environment identities and rejects delivery reuse', async () => {
    const { store, sqlite } = await fixture();
    try {
      const original = paymentInput();
      await store.record(original);
      await expect(
        store.record({ ...paymentInput('different'), delivery_id: original.delivery_id }),
      ).rejects.toBeInstanceOf(PaymentConflictError);
      for (const namespace of [
        { ...original.namespace, account_id: 'second' },
        { ...original.namespace, mode: 'test' as const },
        { ...original.namespace, provider: 'stripe' as const },
      ])
        await store.record({ ...original, namespace });
      await store.record(paymentInput('euro', { currency: 'EUR' }));
      await store.record({ ...original, app_id: 'other-app', environment_id: 'other-env' });
      expect((await store.report(paymentQuery())).totals).toHaveLength(4);
      expect((await store.report(paymentQuery({ provider: 'stripe' }))).totals).toEqual([]);
      const filtered = await store.report(
        paymentQuery({ provider: 'custom', account_id: 'merchant', mode: 'live', currency: 'USD' }),
      );
      expect(filtered.totals).toEqual([
        expect.objectContaining({ gross_minor: 1000, payments: 1, attributed_payments: 0 }),
      ]);
      expect(filtered.dimensions[0].value).toBeNull();
      expect(
        (await store.report(paymentQuery({ app_id: 'other-app', environment_id: 'other-env' })))
          .totals[0].payments,
      ).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});

it('enforces migration replay, foreign environment keys and immutable facts in SQLite', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    sqlite.exec(
      readFileSync(new URL('../migrations/0031_payment_ledger.sql', import.meta.url), 'utf8'),
    );
    const store = new D1PaymentLedger(db);
    await store.record(paymentInput());
    for (const table of ['payment_facts', 'payment_deliveries'])
      expect(() => sqlite.exec(`UPDATE ${table} SET app_id = 'other-app'`)).toThrow('immutable');
    await expect(store.record({ ...paymentInput(), environment_id: 'other-env' })).rejects.toThrow(
      'FOREIGN KEY',
    );
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_facts').get()).toMatchObject({ n: 1 });
  } finally {
    sqlite.close();
  }
});

it('keeps local facts and delivery growth bounded without evicting financial deduplication', async () => {
  const store = new LocalPaymentLedger(1);
  const original = paymentInput();
  await store.record(original);
  await store.record({ ...original, delivery_id: 'retry' });
  expect(await store.record(original)).toBe(false);
  await expect(store.record({ ...original, delivery_id: 'third' })).rejects.toBeInstanceOf(
    PaymentCapacityError,
  );
  await expect(store.record(paymentInput('second'))).rejects.toBeInstanceOf(PaymentCapacityError);
});

it('rejects excessive result cardinality and unsafe integer totals instead of rounding or truncating', async () => {
  const store = new LocalPaymentLedger();
  for (let index = 0; index < 201; index++) {
    const input = paymentInput(`txn-${index}`);
    await store.record({
      ...input,
      namespace: { ...input.namespace, account_id: `account-${index}` },
    });
  }
  await expect(store.report(paymentQuery())).rejects.toBeInstanceOf(PaymentCapacityError);
  expect(() => paymentReport(paymentQuery(), [], Array(501).fill({}), 'd1')).toThrow(
    PaymentCapacityError,
  );
  const unsafe = {
    provider: 'custom',
    account_id: 'merchant',
    mode: 'live',
    currency: 'USD',
    gross_minor: Number.MAX_SAFE_INTEGER + 1,
    refunds_minor: 0,
    net_minor: 0,
    payments: 1,
    refunds: 0,
    attributed_payments: 0,
    pending_refunds: 0,
    pending_refunds_minor: 0,
  };
  expect(() => paymentReport(paymentQuery(), [unsafe], [], 'd1')).toThrow();
});
