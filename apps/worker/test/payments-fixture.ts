import { PaymentIngestV1, RevenueQueryV1 } from '@app-health/contracts';

export function paymentInput(id = 'txn-1', fact: Record<string, unknown> = {}) {
  return PaymentIngestV1.parse({
    schema_version: 1,
    app_id: 'app',
    environment_id: 'env',
    namespace: { provider: 'custom', account_id: 'merchant', mode: 'live' },
    delivery_id: `delivery-${fact.refund_id ?? id}`,
    fact: {
      kind: 'payment',
      transaction_id: id,
      occurred_at: 100,
      amount_minor: 1000,
      currency: 'USD',
      ...fact,
    },
  });
}

export function paymentQuery(patch: Record<string, unknown> = {}) {
  return RevenueQueryV1.parse({
    app_id: 'app',
    environment_id: 'env',
    from: 0,
    to: 1000,
    ...patch,
  });
}
