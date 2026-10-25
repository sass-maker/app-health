import { RevenueReportV1, RevenueTotalV1, type RevenueQueryV1 } from '@app-health/contracts';
import { PaymentCapacityError } from './payments-model.js';

export function paymentReport(
  query: RevenueQueryV1,
  totals: unknown[],
  dimensions: unknown[],
  source: 'local' | 'd1',
): RevenueReportV1 {
  if (totals.length > 200 || dimensions.length > 500) throw new PaymentCapacityError();
  return RevenueReportV1.parse({
    schema_version: 1,
    from: query.from,
    to: query.to,
    source,
    basis: 'recorded_cashflows',
    coverage_note:
      'Exact accepted financial facts, not provider-account completeness. Payments and refunds use their own occurrence times in [from, to). Refunds inherit original attribution; refunds without an original remain pending and are excluded from net. Currency, provider account and test/live totals stay separate. No fees, tax adjustment or exchange conversion is inferred.' +
      (source === 'local' ? ' Local data is cleared on server restart.' : ''),
    breakdown: query.breakdown,
    totals: totals.map((total) => RevenueTotalV1.parse(total)),
    dimensions,
  });
}
