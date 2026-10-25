import {
  ProviderRevenueReportV1,
  RevenueTotalV1,
  type RevenueQueryV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { paymentReportQuery } from './payments-query.js';
import { PROVIDER_COVERAGE, ProviderError } from './payment-provider-model.js';

export async function providerRevenueReport(db: D1DatabaseLike, query: RevenueQueryV1) {
  const plans = [paymentReportQuery(query, false, true), paymentReportQuery(query, true, true)];
  const results = await db.batch(plans.map((plan) => db.prepare(plan.sql).bind(...plan.values)));
  if (results.some((row) => !row.success))
    throw new ProviderError('provider_report_unavailable', 503);
  const totals = results[0].results ?? [],
    dimensions = results[1].results ?? [];
  if (totals.length > 200 || dimensions.length > 500)
    throw new ProviderError('provider_report_capacity_narrow_period', 413);
  const unresolved = await unresolvedResources(db, query);
  return ProviderRevenueReportV1.parse({
    schema_version: 1,
    from: query.from,
    to: query.to,
    source: 'd1',
    basis: 'provider_object_created',
    coverage_note: PROVIDER_COVERAGE,
    breakdown: query.breakdown,
    totals: totals.map((row) => RevenueTotalV1.parse(row)),
    dimensions,
    unresolved: unresolved.results,
  });
}

async function unresolvedResources(db: D1DatabaseLike, query: RevenueQueryV1) {
  const mode = query.mode ?? null,
    provider = query.provider ?? null,
    account = query.account_id ?? null,
    currency = query.currency ?? null;
  const unresolved = await db
    .prepare(
      `SELECT CASE WHEN o.currency IS NULL THEN 'unknown_currency_' || o.reason ELSE o.reason END AS reason, COUNT(*) AS count
    FROM payment_provider_objects o JOIN payment_connections c ON c.id=o.connection_id
    LEFT JOIN payment_assignments a ON a.connection_id=c.id AND a.transaction_id=o.transaction_id
    LEFT JOIN payment_facts f ON (f.provider,f.account_id,f.mode,f.kind,f.fact_id)=(c.provider,c.account_id,c.mode,o.kind,o.resource_id)
      AND (f.app_id,f.environment_id)=(a.app_id,a.environment_id)
    WHERE o.reason IS NOT NULL AND COALESCE(a.app_id,c.app_id)=? AND COALESCE(a.environment_id,c.environment_id)=?
      AND o.resource_created_at>=? AND o.resource_created_at<? AND (? IS NULL OR c.mode=?)
      AND (? IS NULL OR c.provider=?) AND (? IS NULL OR c.account_id=?)
      AND (? IS NULL OR o.currency=? OR o.currency IS NULL OR f.currency=?) GROUP BY 1 LIMIT 51`,
    )
    .bind(
      query.app_id,
      query.environment_id,
      query.from,
      query.to,
      mode,
      mode,
      provider,
      provider,
      account,
      account,
      currency,
      currency,
      currency,
    )
    .all<{ reason: string; count: number }>();
  return unresolved;
}
