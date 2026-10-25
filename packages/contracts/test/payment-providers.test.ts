import { expect, it } from 'vitest';
import {
  PaymentCredentials,
  PaymentConnectionInput,
  PaymentRoutingInput,
  PaymentImportInput,
  ProviderRevenueReportV1,
} from '../src/index.js';
const scope = { app_id: 'app', environment_id: 'production' };
it('bounds credential rotation and rejects header injection, unicode, unknown fields and duplicate product allocation', () => {
  const credentials = { api_key: 'sk_test_synthetic', webhook_secrets: ['whsec_synthetic'] };
  expect(PaymentCredentials.parse(credentials).signature_scheme).toBe('standard');
  expect(
    PaymentConnectionInput.parse({ ...scope, provider: 'stripe', mode: 'test', credentials })
      .fixture,
  ).toBe(false);
  for (const patch of [
    { api_key: 'bad\r\nheader' },
    { api_key: '密钥12345678' },
    { api_key: 'x'.repeat(4097) },
    { webhook_secrets: [] },
    { webhook_secrets: Array(5).fill('whsec_synthetic') },
    { email: 'private' },
  ])
    expect(PaymentCredentials.safeParse({ ...credentials, ...patch }).success).toBe(false);
  const rule = { ...scope, product_id: 'prod_1' };
  expect(PaymentRoutingInput.safeParse({ routing: 'products', rules: [rule] }).success).toBe(true);
  expect(
    PaymentRoutingInput.safeParse({
      routing: 'products',
      rules: [rule, { ...rule, app_id: 'other' }],
    }).success,
  ).toBe(false);
  expect(
    PaymentRoutingInput.safeParse({
      routing: 'products',
      rules: Array.from({ length: 101 }, (_, i) => ({ ...rule, product_id: `prod_${i}` })),
    }).success,
  ).toBe(false);
});
it('requires nonempty historical import windows and keeps provider revenue explicitly distinct', () => {
  expect(PaymentImportInput.safeParse({ from: 0, to: Date.now() }).success).toBe(true);
  for (const value of [
    { from: 10, to: 10 },
    { from: 10, to: 1 },
    { from: -1, to: 10 },
    { from: 0, to: Date.now() + 600000 },
    { from: 0, to: 10, customer: 'private' },
  ])
    expect(PaymentImportInput.safeParse(value).success).toBe(false);
  const report = {
    schema_version: 1,
    from: 0,
    to: 1,
    source: 'd1',
    basis: 'provider_object_created',
    coverage_note: 'Observed provider objects',
    breakdown: 'source',
    totals: [],
    dimensions: [],
    unresolved: [],
  };
  expect(ProviderRevenueReportV1.safeParse(report).success).toBe(true);
  expect(ProviderRevenueReportV1.safeParse({ ...report, basis: 'recorded_cashflow' }).success).toBe(
    false,
  );
  expect(
    ProviderRevenueReportV1.safeParse({
      ...report,
      unresolved: Array(51).fill({ reason: 'unmapped', count: 1 }),
    }).success,
  ).toBe(false);
});
