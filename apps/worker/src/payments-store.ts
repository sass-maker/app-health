import { PaymentIngestV1, RevenueQueryV1 } from '@app-health/contracts';
import { hashKey } from './crypto.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import { PaymentConflictError, paymentFactId, type PaymentLedgerStore } from './payments-model.js';
import { paymentReport } from './payments-report.js';
import { paymentReportQuery } from './payments-query.js';

function namespaceValues(input: PaymentIngestV1) {
  return [
    input.app_id,
    input.environment_id,
    input.namespace.provider,
    input.namespace.account_id,
    input.namespace.mode,
  ];
}

function factValues(input: PaymentIngestV1, hash: string, now: number) {
  const fact = input.fact;
  const attribution = fact.kind === 'payment' ? fact.attribution : {};
  return [
    ...namespaceValues(input),
    fact.kind,
    paymentFactId(input),
    fact.transaction_id,
    fact.occurred_at,
    fact.amount_minor,
    fact.currency,
    attribution.source ?? null,
    attribution.page ?? null,
    attribution.country ?? null,
    attribution.campaign ?? null,
    hash,
    now,
  ];
}

/** Atomic receipts and immutable canonical facts; SQL guards both arrival orders. */
export class D1PaymentLedger implements PaymentLedgerStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async record(value: PaymentIngestV1): Promise<boolean> {
    const input = PaymentIngestV1.parse(value);
    const hash = await hashKey(JSON.stringify(input.fact));
    const now = Date.now();
    try {
      const results = await this.db.batch([
        this.db
          .prepare(
            `INSERT OR IGNORE INTO payment_deliveries
            (app_id, environment_id, provider, account_id, mode, delivery_id, fact_hash, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(...namespaceValues(input), input.delivery_id, hash, now),
        this.db
          .prepare(
            `INSERT OR IGNORE INTO payment_facts
            (app_id, environment_id, provider, account_id, mode, kind, fact_id, transaction_id,
             occurred_at, amount_minor, currency, source, page, country, campaign, fact_hash, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(...factValues(input, hash, now)),
      ]);
      if (results.some((result) => !result.success)) throw new Error('Financial write failed');
      return (results[1].meta.changes ?? 0) > 0;
    } catch (error) {
      if (
        error instanceof Error &&
        /payment (identity|delivery|refund) conflict/.test(error.message)
      )
        throw new PaymentConflictError();
      throw error;
    }
  }

  async report(value: RevenueQueryV1) {
    const query = RevenueQueryV1.parse(value);
    const plans = [paymentReportQuery(query, false), paymentReportQuery(query, true)];
    const rows = await this.db.batch(
      plans.map((plan) => this.db.prepare(plan.sql).bind(...plan.values)),
    );
    if (rows.some((row) => !row.success)) throw new Error('Financial read failed');
    return paymentReport(query, rows[0].results ?? [], rows[1].results ?? [], 'd1');
  }
}
