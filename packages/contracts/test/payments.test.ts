import { describe, expect, it } from 'vitest';
import {
  PaymentIngestV1,
  PaymentReceiptV1,
  RevenueQueryV1,
  RevenueReportV1,
} from '../src/index.js';

const payment = {
  schema_version: 1,
  app_id: 'app',
  environment_id: 'production',
  namespace: { provider: 'custom', account_id: 'merchant', mode: 'test' },
  delivery_id: 'delivery-1',
  fact: {
    kind: 'payment',
    transaction_id: 'txn',
    occurred_at: 100,
    amount_minor: 2999,
    currency: 'USD',
  },
};

describe('versioned financial contracts', () => {
  it('accepts explicit bounded financial facts with independent refund IDs and normalized attribution', () => {
    expect(PaymentIngestV1.parse(payment).fact).toMatchObject({ attribution: {} });
    expect(
      PaymentIngestV1.parse({
        ...payment,
        fact: {
          ...payment.fact,
          attribution: { source: 'X', page: '/pricing', country: 'US', campaign: 'launch' },
        },
      }).fact,
    ).toMatchObject({ attribution: { source: 'X' } });
    expect(
      PaymentIngestV1.parse({
        ...payment,
        fact: { ...payment.fact, kind: 'refund', refund_id: 'refund-1' },
      }).fact.kind,
    ).toBe('refund');
    for (const provider of ['stripe', 'polar', 'dodo'])
      expect(
        PaymentIngestV1.safeParse({ ...payment, namespace: { ...payment.namespace, provider } })
          .success,
      ).toBe(true);
    expect(
      PaymentReceiptV1.parse({ schema_version: 1, recorded: false, duplicate: true }).duplicate,
    ).toBe(true);
  });
  it('rejects identity, arbitrary properties, unbounded metadata, negative/floating/unsafe amounts and unversioned bodies', () => {
    for (const amount_minor of [-1, 0.01, Infinity, NaN, 1e12 + 1, Number.MAX_SAFE_INTEGER + 1])
      expect(
        PaymentIngestV1.safeParse({ ...payment, fact: { ...payment.fact, amount_minor } }).success,
      ).toBe(false);
    for (const attribution of [
      { email: 'a@example.test' },
      { source: 'a@example.test' },
      { source: 'x'.repeat(101) },
      { page: '/thanks?token=private' },
      { page: '/a#b' },
      { country: 'usa' },
      { campaign: '' },
    ])
      expect(
        PaymentIngestV1.safeParse({ ...payment, fact: { ...payment.fact, attribution } }).success,
      ).toBe(false);
    for (const patch of [
      { schema_version: 2 },
      { app_id: 'bad id' },
      { delivery_id: '' },
      { body: 'raw' },
      { namespace: { ...payment.namespace, mode: 'sandbox' } },
    ])
      expect(PaymentIngestV1.safeParse({ ...payment, ...patch }).success).toBe(false);
    expect(
      PaymentIngestV1.safeParse({
        ...payment,
        fact: { ...payment.fact, kind: 'refund', refund_id: 'refund', amount_minor: 0 },
      }).success,
    ).toBe(false);
    expect(
      PaymentIngestV1.safeParse({ ...payment, fact: { ...payment.fact, kind: 'refund' } }).success,
    ).toBe(false);
  });
  it('bounds report periods, dimensions and currencies while preserving mixed mode separation', () => {
    const query = { app_id: 'app', environment_id: 'env', from: '0', to: '100' };
    expect(RevenueQueryV1.parse(query)).toMatchObject({ from: 0, to: 100, breakdown: 'source' });
    for (const patch of [
      { from: 100 },
      { to: 367 * 86400000 },
      { mode: 'all' },
      { currency: 'usd' },
      { breakdown: 'email' },
      { workspace: 'foreign' },
    ])
      expect(RevenueQueryV1.safeParse({ ...query, ...patch }).success).toBe(false);
    const report = {
      schema_version: 1,
      from: 0,
      to: 100,
      source: 'd1',
      basis: 'recorded_cashflows',
      coverage_note: 'Recorded financial facts only',
      breakdown: 'source',
      totals: [],
      dimensions: [],
    };
    expect(RevenueReportV1.parse(report)).toEqual(report);
    expect(RevenueReportV1.safeParse({ ...report, source: 'stripe' }).success).toBe(false);
  });
});
