import { PaymentConnection, PaymentImportJob } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import {
  PROVIDER_COVERAGE,
  ProviderError,
  type ConnectionRow,
  type JobRow,
} from './payment-provider-model.js';

export function publicConnection(row: ConnectionRow, rules: PaymentConnection['rules'] = []) {
  const { cipher: _cipher, workspace_id: _workspace, ...safe } = row;
  return PaymentConnection.parse({
    ...safe,
    rules,
    webhook_path: `/v1/payment-webhooks/${row.provider}/${row.id}`,
    fixture: false,
  });
}
export function publicJob(row: JobRow) {
  return PaymentImportJob.parse({
    id: row.id,
    connection_id: row.connection_id,
    kind: row.kind,
    status: row.status,
    phase: row.phase,
    from: row.from_time,
    to: row.to_time,
    processed: row.processed,
    recorded: row.recorded,
    unresolved: row.unresolved,
    filtered: row.filtered,
    reason: row.reason,
    retry_at: row.retry_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    coverage_note: PROVIDER_COVERAGE,
  });
}
export async function connectionRow(db: D1DatabaseLike, id: string): Promise<ConnectionRow> {
  const row = await db
    .prepare('SELECT * FROM payment_connections WHERE id=?')
    .bind(id)
    .first<ConnectionRow>();
  if (!row) throw new ProviderError('payment_connection_not_found', 404);
  return row;
}
export async function connectionRules(db: D1DatabaseLike, id: string) {
  return (
    await db
      .prepare(
        'SELECT product_id,app_id,environment_id FROM payment_routing_rules WHERE connection_id=? ORDER BY product_id LIMIT 101',
      )
      .bind(id)
      .all<PaymentConnection['rules'][number]>()
  ).results;
}
export async function listConnections(
  db: D1DatabaseLike,
  scope: { app_id: string; environment_id: string },
) {
  const rows = (
    await db
      .prepare(
        `SELECT * FROM payment_connections WHERE app_id=? AND environment_id=? ORDER BY created_at LIMIT 51`,
      )
      .bind(scope.app_id, scope.environment_id)
      .all<ConnectionRow>()
  ).results;
  if (rows.length > 50) throw new ProviderError('payment_connection_capacity', 413);
  return Promise.all(
    rows.map(async (row) => publicConnection(row, await connectionRules(db, row.id))),
  );
}
export async function jobRow(db: D1DatabaseLike, id: string): Promise<JobRow> {
  const row = await db
    .prepare('SELECT * FROM payment_provider_jobs WHERE id=?')
    .bind(id)
    .first<JobRow>();
  if (!row) throw new ProviderError('payment_job_not_found', 404);
  return row;
}
export async function activeConnection(db: D1DatabaseLike, id: string, generation: number) {
  const row = await connectionRow(db, id);
  if (row.status !== 'active' || row.generation !== generation || !row.cipher)
    throw new ProviderError('payment_connection_changed_or_disconnected', 409);
  return row;
}
