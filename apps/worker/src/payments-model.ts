import type { PaymentIngestV1, RevenueQueryV1, RevenueReportV1 } from '@app-health/contracts';

export interface PaymentLedgerStore {
  record(input: PaymentIngestV1): Promise<boolean>;
  report(query: RevenueQueryV1): Promise<RevenueReportV1>;
}

export class PaymentConflictError extends Error {
  constructor() {
    super('Payment identity, delivery or refund conflicts with recorded financial facts');
  }
}

export class PaymentCapacityError extends Error {
  constructor() {
    super('Financial capacity exceeded; narrow the report or use durable storage');
  }
}

export function paymentNamespaceKey(input: PaymentIngestV1) {
  return JSON.stringify([input.app_id, input.environment_id, input.namespace]);
}

export function paymentFactId(input: PaymentIngestV1) {
  return input.fact.kind === 'payment' ? input.fact.transaction_id : input.fact.refund_id;
}

export function paymentFactKey(input: PaymentIngestV1) {
  return JSON.stringify([paymentNamespaceKey(input), input.fact.kind, paymentFactId(input)]);
}
