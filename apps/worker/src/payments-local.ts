import { PaymentIngestV1, RevenueQueryV1, type RevenueTotalV1 } from '@app-health/contracts';
import { hashKey } from './crypto.js';
import {
  PaymentCapacityError,
  PaymentConflictError,
  paymentFactKey,
  paymentNamespaceKey,
  type PaymentLedgerStore,
} from './payments-model.js';
import { paymentReport } from './payments-report.js';

interface LocalFact {
  input: PaymentIngestV1;
  hash: string;
}

function originalKey(input: PaymentIngestV1) {
  return JSON.stringify([paymentNamespaceKey(input), 'payment', input.fact.transaction_id]);
}

function validateRefunds(input: PaymentIngestV1, facts: Map<string, LocalFact>) {
  const related = [...facts.values()].filter(
    (row) =>
      paymentNamespaceKey(row.input) === paymentNamespaceKey(input) &&
      row.input.fact.transaction_id === input.fact.transaction_id,
  );
  const original = input.fact.kind === 'payment' ? input : facts.get(originalKey(input))?.input;
  if (!original) return;
  const refunds = [...related.map((row) => row.input), input].filter(
    (row) => row.fact.kind === 'refund',
  );
  if (
    refunds.some((row) => row.fact.currency !== original.fact.currency) ||
    refunds.reduce((sum, row) => sum + row.fact.amount_minor, 0) > original.fact.amount_minor
  )
    throw new PaymentConflictError();
}

function matchesQuery(input: PaymentIngestV1, query: RevenueQueryV1) {
  return (
    input.app_id === query.app_id &&
    input.environment_id === query.environment_id &&
    input.fact.occurred_at >= query.from &&
    input.fact.occurred_at < query.to &&
    (!query.currency || input.fact.currency === query.currency) &&
    (!query.mode || input.namespace.mode === query.mode) &&
    (!query.provider || input.namespace.provider === query.provider) &&
    (!query.account_id || input.namespace.account_id === query.account_id)
  );
}

function emptyTotal(input: PaymentIngestV1): RevenueTotalV1 {
  return {
    ...input.namespace,
    currency: input.fact.currency,
    gross_minor: 0,
    refunds_minor: 0,
    net_minor: 0,
    payments: 0,
    refunds: 0,
    attributed_payments: 0,
    pending_refunds: 0,
    pending_refunds_minor: 0,
  };
}

function addFact(total: RevenueTotalV1, input: PaymentIngestV1, original?: PaymentIngestV1) {
  if (input.fact.kind === 'payment') {
    total.gross_minor += input.fact.amount_minor;
    total.net_minor += input.fact.amount_minor;
    total.payments++;
    total.attributed_payments += Object.keys(input.fact.attribution).length ? 1 : 0;
  } else if (original) {
    total.refunds_minor += input.fact.amount_minor;
    total.net_minor -= input.fact.amount_minor;
    total.refunds++;
  } else {
    total.pending_refunds_minor += input.fact.amount_minor;
    total.pending_refunds++;
  }
}

function localRows(facts: Map<string, LocalFact>, query: RevenueQueryV1, dimension: boolean) {
  const groups = new Map<string, RevenueTotalV1 & { value?: string | null }>();
  for (const { input } of facts.values()) {
    if (!matchesQuery(input, query)) continue;
    const original = facts.get(originalKey(input))?.input;
    const attribution = original?.fact.kind === 'payment' ? original.fact.attribution : {};
    const value = attribution[query.breakdown] ?? null;
    const groupKey = JSON.stringify([input.namespace, input.fact.currency, dimension ? value : '']);
    const total = groups.get(groupKey) ?? {
      ...emptyTotal(input),
      ...(dimension ? { value } : {}),
    };
    addFact(total, input, original);
    groups.set(groupKey, total);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

/** Development-only bounded ledger, never a fallback when production D1 fails. */
export class LocalPaymentLedger implements PaymentLedgerStore {
  private readonly facts = new Map<string, LocalFact>();
  private readonly deliveries = new Map<string, string>();

  constructor(private readonly capacity = 10_000) {}

  async record(value: PaymentIngestV1) {
    const input = PaymentIngestV1.parse(value);
    const hash = await hashKey(JSON.stringify(input.fact));
    const factKey = paymentFactKey(input);
    const deliveryKey = JSON.stringify([paymentNamespaceKey(input), input.delivery_id]);
    const previous = this.facts.get(factKey);
    const delivered = this.deliveries.get(deliveryKey);
    if ((previous && previous.hash !== hash) || (delivered && delivered !== hash))
      throw new PaymentConflictError();
    if (!previous && this.facts.size >= this.capacity) throw new PaymentCapacityError();
    if (!delivered && this.deliveries.size >= this.capacity * 2) throw new PaymentCapacityError();
    if (!previous) validateRefunds(input, this.facts);
    this.deliveries.set(deliveryKey, hash);
    this.facts.set(factKey, { input, hash });
    return !previous;
  }

  async report(value: RevenueQueryV1) {
    const query = RevenueQueryV1.parse(value);
    return paymentReport(
      query,
      localRows(this.facts, query, false),
      localRows(this.facts, query, true),
      'local',
    );
  }
}
