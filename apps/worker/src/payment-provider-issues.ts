import { providerOperationFence } from './payment-provider-fence.js';
import { ProviderError, type ProviderSession } from './payment-provider-model.js';
import type { D1DatabaseLike } from './d1-adapter.js';
export function permanentResourceError(error: unknown): error is ProviderError {
  return (
    error instanceof ProviderError &&
    error.status < 500 &&
    error.retryAt === 0 &&
    ![401, 403].includes(error.status)
  );
}
export async function rememberProviderIssue(
  db: D1DatabaseLike,
  session: ProviderSession,
  kind: 'payment' | 'refund',
  id: string,
  error: ProviderError,
) {
  const c = session.connection,
    gate = providerOperationFence({
      connectionId: c.id,
      generation: c.generation,
      ...session.fence,
    });
  const reason = /^[a-z0-9_]{1,120}$/.test(error.code) ? error.code : 'invalid_provider_resource';
  try {
    const result = await db
      .prepare(
        `INSERT INTO payment_provider_issues(connection_id,kind,resource_id,reason,observed_at) SELECT ?,?,?,?,? ${gate.sql}
 ON CONFLICT(connection_id,kind,resource_id) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at`,
      )
      .bind(c.id, kind, id, reason, Date.now(), ...gate.values)
      .run();
    if (!result.meta.changes) throw new ProviderError('job_lease_or_generation_changed', 409);
  } catch (error) {
    if (error instanceof Error && error.message.includes('provider issue capacity'))
      throw new ProviderError('provider_issue_capacity', 413);
    throw error;
  }
}
