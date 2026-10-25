import type { PaymentIngestV1 } from '@app-health/contracts';

export type ProviderLedgerFence = {
  connectionId: string;
  generation: number;
  jobId?: string;
  leaseToken?: string;
};
// SQL clock evaluation also fences a write delayed past lease expiry in D1.
const PROVIDER_SQL_NOW_MS =
  "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export function providerOperationFence(fence: ProviderLedgerFence) {
  let sql =
    "WHERE EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active' AND cipher IS NOT NULL)";
  const values: unknown[] = [fence.connectionId, fence.generation];
  if (fence.jobId) {
    sql += ` AND EXISTS(SELECT 1 FROM payment_provider_jobs WHERE id=? AND connection_id=? AND generation=? AND lease_token=? AND lease_until>${PROVIDER_SQL_NOW_MS} AND status='running')`;
    values.push(fence.jobId, fence.connectionId, fence.generation, fence.leaseToken);
  }
  return { sql, values };
}
export function providerLedgerFence(input: PaymentIngestV1, fence?: ProviderLedgerFence) {
  if (!fence)
    return { sql: '', values: [] as unknown[], check: [] as { sql: string; values: unknown[] }[] };
  const gate = providerOperationFence(fence);
  const sql =
    gate.sql +
    ` AND EXISTS(SELECT 1 FROM payment_connections c JOIN payment_assignments a ON a.connection_id=c.id WHERE c.id=? AND c.provider=? AND c.account_id=? AND c.mode=? AND a.transaction_id=? AND a.app_id=? AND a.environment_id=?)`;
  const values = [
    ...gate.values,
    fence.connectionId,
    input.namespace.provider,
    input.namespace.account_id,
    input.namespace.mode,
    input.fact.transaction_id,
    input.app_id,
    input.environment_id,
  ];
  return { sql, values, check: [{ sql: `SELECT 1 ${sql}`, values }] };
}
