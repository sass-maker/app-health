import type { RevenueQueryV1 } from '@app-health/contracts';

const namespace = 'f.provider, f.account_id, f.mode, f.currency';
const join = `LEFT JOIN payment_facts p ON
  (p.app_id, p.environment_id, p.provider, p.account_id, p.mode, p.kind, p.fact_id) =
  (f.app_id, f.environment_id, f.provider, f.account_id, f.mode, 'payment', f.transaction_id)`;
const amounts = `
  COALESCE(SUM(CASE WHEN f.kind = 'payment' THEN f.amount_minor ELSE 0 END), 0) AS gross_minor,
  COALESCE(SUM(CASE WHEN f.kind = 'refund' AND p.fact_id IS NOT NULL THEN f.amount_minor ELSE 0 END), 0) AS refunds_minor,
  COALESCE(SUM(CASE WHEN f.kind = 'payment' THEN f.amount_minor WHEN p.fact_id IS NOT NULL THEN -f.amount_minor ELSE 0 END), 0) AS net_minor,
  SUM(f.kind = 'payment') AS payments,
  SUM(f.kind = 'refund' AND p.fact_id IS NOT NULL) AS refunds,
  SUM(f.kind = 'payment' AND (f.source IS NOT NULL OR f.page IS NOT NULL OR f.country IS NOT NULL OR f.campaign IS NOT NULL)) AS attributed_payments,
  SUM(f.kind = 'refund' AND p.fact_id IS NULL) AS pending_refunds,
  COALESCE(SUM(CASE WHEN f.kind = 'refund' AND p.fact_id IS NULL THEN f.amount_minor ELSE 0 END), 0) AS pending_refunds_minor`;

export function paymentReportQuery(query: RevenueQueryV1, dimension: boolean) {
  const clauses = [
    'f.app_id = ?',
    'f.environment_id = ?',
    'f.occurred_at >= ?',
    'f.occurred_at < ?',
  ];
  const values: unknown[] = [query.app_id, query.environment_id, query.from, query.to];
  for (const field of ['mode', 'currency', 'provider', 'account_id'] as const) {
    if (query[field] !== undefined) {
      clauses.push(`f.${field} = ?`);
      values.push(query[field]);
    }
  }
  // breakdown is a bounded enum, never an arbitrary SQL identifier.
  const label = dimension ? `, p.${query.breakdown} AS value` : '';
  const group = namespace + (dimension ? `, p.${query.breakdown}` : '');
  return {
    sql: `SELECT ${namespace}${label}, ${amounts} FROM payment_facts f ${join}
      WHERE ${clauses.join(' AND ')} GROUP BY ${group}
      ORDER BY ${group} LIMIT ${dimension ? 501 : 201}`,
    values,
  };
}
