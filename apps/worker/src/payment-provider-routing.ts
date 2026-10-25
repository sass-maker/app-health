import { providerOperationFence, type ProviderLedgerFence } from './payment-provider-fence.js';
import { type PaymentRoutingInput, type PaymentScopeV1 } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { connectionRules } from './payment-provider-store.js';
import {
  ProviderError,
  type ConnectionRow,
  type NormalizedResource,
  type RoutingTarget,
} from './payment-provider-model.js';

async function assignedTarget(db: D1DatabaseLike, connection: string, transaction: string) {
  return db
    .prepare(
      'SELECT app_id,environment_id FROM payment_assignments WHERE connection_id=? AND transaction_id=?',
    )
    .bind(connection, transaction)
    .first<RoutingTarget>();
}
async function routeTarget(
  db: D1DatabaseLike,
  c: ConnectionRow,
  resource: NormalizedResource,
): Promise<RoutingTarget> {
  if (c.routing === 'exclusive') return { app_id: c.app_id, environment_id: c.environment_id };
  if (!resource.products?.length)
    throw new ProviderError('product_evidence_unavailable_or_cart_exceeds_bound');
  const rules = await connectionRules(db, c.id);
  const destinations = resource.products.map((product) =>
    rules.find((rule) => rule.product_id === product),
  );
  if (destinations.some((target) => !target)) throw new ProviderError('unmapped_product_cart');
  const unique = new Map(
    destinations.map((target) => [
      JSON.stringify([target!.app_id, target!.environment_id]),
      target!,
    ]),
  );
  if (unique.size !== 1) throw new ProviderError('mixed_destination_cart_no_allocation');
  return [...unique.values()][0];
}
export async function assignOriginal(
  db: D1DatabaseLike,
  c: ConnectionRow,
  resource: NormalizedResource,
  jobFence?: Pick<ProviderLedgerFence, 'jobId' | 'leaseToken'>,
) {
  const existing = await assignedTarget(db, c.id, resource.transaction);
  if (existing) return existing;
  const target = await routeTarget(db, c, resource);
  const validity = routingValidity(c, resource, target);
  const gate = providerOperationFence({
    connectionId: c.id,
    generation: c.generation,
    ...jobFence,
  });
  await db
    .prepare(
      `INSERT OR IGNORE INTO payment_assignments(connection_id,transaction_id,app_id,environment_id,assigned_at)
    SELECT ?,?,?,?,? ${gate.sql} ${validity.sql}`,
    )
    .bind(
      c.id,
      resource.transaction,
      target.app_id,
      target.environment_id,
      Date.now(),
      ...gate.values,
      ...validity.values,
    )
    .run();
  const assigned = await assignedTarget(db, c.id, resource.transaction);
  if (!assigned) throw new ProviderError('payment_connection_changed_or_disconnected', 409);
  return assigned;
}
export async function saveRouting(
  db: D1DatabaseLike,
  c: ConnectionRow,
  input: PaymentRoutingInput,
) {
  const statements = [
    db
      .prepare(
        `UPDATE payment_connections SET routing=? WHERE id=? AND generation=? AND status='active'`,
      )
      .bind(input.routing, c.id, c.generation),
    db
      .prepare(
        "DELETE FROM payment_routing_rules WHERE connection_id=? AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active')",
      )
      .bind(c.id, c.id, c.generation),
  ];
  for (const rule of input.rules)
    statements.push(
      db
        .prepare(
          `INSERT INTO payment_routing_rules(connection_id,product_id,app_id,environment_id)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active')`,
        )
        .bind(c.id, rule.product_id, rule.app_id, rule.environment_id, c.id, c.generation),
    );
  const result = await db.batch(statements);
  if (!result[0].meta.changes)
    throw new ProviderError('payment_connection_changed_or_disconnected', 409);
}
export async function providerScopeAllowed(
  db: D1DatabaseLike,
  scope: PaymentScopeV1,
  workspace: string,
) {
  return !!(await db
    .prepare(
      `SELECT 1 FROM environments e JOIN workspace_apps w ON w.app_id=e.app_id
    WHERE e.id=? AND e.app_id=? AND w.workspace_id=?`,
    )
    .bind(scope.environment_id, scope.app_id, workspace)
    .first());
}

function routingValidity(c: ConnectionRow, resource: NormalizedResource, target: RoutingTarget) {
  const sql = 'AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND routing=?)';
  const values: unknown[] = [c.id, c.routing];
  if (c.routing === 'exclusive') return { sql, values };
  const products = resource.products ?? [];
  return {
    sql:
      sql +
      ` AND (SELECT COUNT(*) FROM payment_routing_rules WHERE connection_id=? AND product_id IN (${products.map(() => '?').join(',')}) AND app_id=? AND environment_id=?)=?`,
    values: [...values, c.id, ...products, target.app_id, target.environment_id, products.length],
  };
}
