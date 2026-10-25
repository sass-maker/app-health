import { permanentResourceError, rememberProviderIssue } from './payment-provider-issues.js';
import { providerOperationFence } from './payment-provider-fence.js';
import { PaymentIngestV1 } from '@app-health/contracts';
import { hashKey } from './crypto.js';
import { D1PaymentLedger } from './payments-store.js';
import { PaymentConflictError } from './payments-model.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import { providerResource } from './payment-provider-api.js';
import { normalizeProviderResource, providerAttribution } from './payment-provider-normalize.js';
import { assignOriginal } from './payment-provider-routing.js';
import { stripeProducts } from './payment-provider-products.js';
import {
  ProviderError,
  type NormalizedResource,
  type ProviderSession,
  type Resource,
} from './payment-provider-model.js';

async function remember(
  db: D1DatabaseLike,
  session: ProviderSession,
  resource: NormalizedResource,
) {
  const c = session.connection;
  const gate = providerOperationFence({
    connectionId: c.id,
    generation: c.generation,
    ...session.fence,
  });
  const attribution = resource.kind === 'payment' ? providerAttribution(resource.metadata) : {};
  const result = await db
    .prepare(
      `INSERT INTO payment_provider_objects(connection_id,kind,resource_id,transaction_id,resource_created_at,currency,reason,source,page,country,campaign,observed_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? ${gate.sql}
    ON CONFLICT(connection_id,kind,resource_id) DO UPDATE SET reason=excluded.reason,currency=COALESCE(currency,excluded.currency), source=COALESCE(excluded.source,source),
    page=COALESCE(excluded.page,page),country=COALESCE(excluded.country,country),campaign=COALESCE(excluded.campaign,campaign),observed_at=excluded.observed_at`,
    )
    .bind(
      c.id,
      resource.kind,
      resource.id,
      resource.transaction,
      resource.time,
      /^[A-Z]{3}$/.test(resource.currency) ? resource.currency : null,
      resource.reason,
      attribution.source ?? null,
      attribution.page ?? null,
      attribution.country ?? null,
      attribution.campaign ?? null,
      Date.now(),
      ...gate.values,
    )
    .run();
  if (!result.meta.changes) throw new ProviderError('job_lease_or_generation_changed', 409);
  await db
    .prepare(
      `DELETE FROM payment_provider_issues WHERE connection_id=? AND kind=? AND resource_id=? AND EXISTS(SELECT 1 ${gate.sql})`,
    )
    .bind(c.id, resource.kind, resource.id, ...gate.values)
    .run();
}
async function originalFact(
  db: D1DatabaseLike,
  session: ProviderSession,
  resource: NormalizedResource,
) {
  const target = await assignOriginal(db, session.connection, resource, session.fence);
  return writeFact(db, session, resource, target);
}
async function writeFact(
  db: D1DatabaseLike,
  session: ProviderSession,
  resource: NormalizedResource,
  target: { app_id: string; environment_id: string },
) {
  const c = session.connection;
  const fields = {
    transaction_id: resource.transaction,
    occurred_at: resource.time,
    amount_minor: resource.amount,
    currency: resource.currency,
  };
  const fact =
    resource.kind === 'payment'
      ? { kind: 'payment', ...fields, attribution: {} }
      : { kind: 'refund', ...fields, refund_id: resource.id };
  const input = PaymentIngestV1.parse({
    schema_version: 1,
    ...target,
    namespace: { provider: c.provider, account_id: c.account_id, mode: c.mode },
    delivery_id: await hashKey(`${resource.kind}:${resource.id}:normalization-v1`),
    fact,
  });
  return new D1PaymentLedger(db).record(input, {
    connectionId: c.id,
    generation: c.generation,
    ...session.fence,
  });
}
async function recordNormalized(
  db: D1DatabaseLike,
  session: ProviderSession,
  resource: NormalizedResource,
  row: Resource,
): Promise<boolean> {
  if (resource.kind === 'payment') {
    if (session.connection.routing === 'products' && session.connection.provider === 'stripe')
      resource.products = await stripeProducts(session, row);
    return originalFact(db, session, resource);
  }
  const original = await providerResource(session, 'payment', resource.transaction);
  const normalized = normalizeProviderResource(session.connection, original, 'payment');
  if (normalized.reason) throw new ProviderError(`original_${normalized.reason}`);
  await processNormalized(db, session, normalized, original);
  if (normalized.reason) throw new ProviderError('original_routing_or_financial_conflict');
  const target = await assignOriginal(db, session.connection, normalized, session.fence);
  return writeFact(db, session, resource, target);
}
async function processNormalized(
  db: D1DatabaseLike,
  session: ProviderSession,
  resource: NormalizedResource,
  row: Resource,
) {
  let recorded = false;
  if (!resource.reason) {
    try {
      recorded = await recordNormalized(db, session, resource, row);
    } catch (error) {
      if (permanentResourceError(error)) resource.reason = error.code;
      else if (error instanceof PaymentConflictError)
        resource.reason = 'financial_identity_or_refund_conflict';
      else throw error;
    }
  }
  await remember(db, session, resource);
  return { recorded: Number(recorded), unresolved: Number(resource.reason !== null), filtered: 0 };
}
async function processResource(
  db: D1DatabaseLike,
  session: ProviderSession,
  kind: 'payment' | 'refund',
  id: string,
  window?: { from: number; to: number },
) {
  const row = await providerResource(session, kind, id);
  if (
    session.connection.provider === 'dodo' &&
    row.business_id === session.connection.account_id &&
    row.brand_id !== session.connection.selector
  )
    return { recorded: 0, unresolved: 0, filtered: 1 };
  const normalized = normalizeProviderResource(session.connection, row, kind);
  if (window && (normalized.time < window.from || normalized.time >= window.to))
    return { recorded: 0, unresolved: 0, filtered: 1 };
  if (normalized.id !== id) throw new ProviderError('provider_resource_identity_mismatch', 409);
  return processNormalized(db, session, normalized, row);
}

export async function processProviderResource(
  db: D1DatabaseLike,
  session: ProviderSession,
  kind: 'payment' | 'refund',
  id: string,
  window?: { from: number; to: number },
) {
  try {
    return await processResource(db, session, kind, id, window);
  } catch (error) {
    if (!permanentResourceError(error)) throw error;
    await rememberProviderIssue(db, session, kind, id, error);
    return { recorded: 0, unresolved: 1, filtered: 0 };
  }
}
