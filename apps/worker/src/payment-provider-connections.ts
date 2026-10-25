import { dispatchProviderJob } from './payment-provider-wake.js';
import { type PaymentConnectionInput, type PaymentCredentials } from '@app-health/contracts';
import { verifyProviderAccount } from './payment-provider-api.js';
import {
  openProviderCredentials,
  sealProviderCredentials,
  validateProviderKeyring,
} from './payment-provider-crypto.js';
import { activeConnection, connectionRules, publicConnection } from './payment-provider-store.js';
import {
  ProviderError,
  type ConnectionRow,
  type ProviderRuntime,
} from './payment-provider-model.js';

export async function createProviderConnection(
  runtime: ProviderRuntime,
  workspace: string,
  input: PaymentConnectionInput,
) {
  if (input.fixture || !input.credentials)
    throw new ProviderError('real_connection_requires_credentials');
  validateProviderKeyring(runtime.keyring);
  const account = await verifyProviderAccount(input, runtime.fetcher);
  const row: ConnectionRow = {
    id: crypto.randomUUID(),
    workspace_id: workspace,
    app_id: input.app_id,
    environment_id: input.environment_id,
    provider: input.provider,
    account_id: account,
    mode: input.mode,
    selector: input.selector ?? null,
    generation: 1,
    status: 'active',
    routing: 'exclusive',
    cipher: null,
    created_at: Date.now(),
    verified_at: Date.now(),
    webhook_at: null,
  };
  row.cipher = await sealProviderCredentials(runtime.keyring, row, input.credentials);
  try {
    const result = await runtime.db
      .prepare(
        `INSERT INTO payment_connections(id,workspace_id,app_id,environment_id,provider,account_id,mode,selector,generation,status,routing,cipher,created_at,verified_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM payment_connections WHERE app_id=? AND environment_id=?) < 50`,
      )
      .bind(
        row.id,
        workspace,
        row.app_id,
        row.environment_id,
        row.provider,
        row.account_id,
        row.mode,
        row.selector,
        1,
        'active',
        'exclusive',
        row.cipher,
        row.created_at,
        row.verified_at,
        row.app_id,
        row.environment_id,
      )
      .run();
    if (!result.meta.changes) throw new ProviderError('payment_connection_capacity', 413);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('provider_account_reserved_or_connection_unavailable', 409);
  }
  return publicConnection(row);
}
function verificationInput(
  c: ConnectionRow,
  credentials: PaymentCredentials,
): PaymentConnectionInput {
  return {
    app_id: c.app_id,
    environment_id: c.environment_id,
    provider: c.provider,
    mode: c.mode,
    ...(c.selector ? { selector: c.selector } : {}),
    credentials,
    fixture: false,
  };
}
export async function replaceProviderCredentials(
  runtime: ProviderRuntime,
  c: ConnectionRow,
  credentials: PaymentCredentials,
) {
  validateProviderKeyring(runtime.keyring);
  const account = await verifyProviderAccount(verificationInput(c, credentials), runtime.fetcher);
  if (account !== c.account_id) throw new ProviderError('replacement_account_mismatch', 409);
  const updated = {
    ...c,
    generation: c.generation + 1,
    status: 'active' as const,
    verified_at: Date.now(),
  };
  const cipher = await sealProviderCredentials(runtime.keyring, updated, credentials);
  const results = await runtime.db.batch([
    runtime.db
      .prepare(
        `UPDATE payment_connections SET cipher=?,generation=?,status='active',verified_at=? WHERE id=? AND generation=?`,
      )
      .bind(cipher, updated.generation, updated.verified_at, c.id, c.generation),
    runtime.db
      .prepare(
        `UPDATE payment_provider_jobs SET generation=?,status='queued',reason=NULL,retry_at=0,lease_token=NULL,lease_until=0,wake_token=NULL,wake_until=0,updated_at=?
      WHERE connection_id=? AND kind='webhook' AND (status IN ('queued','running','paused') OR (status='cancelled' AND reason IN ('connection_generation_changed','connection_disconnected')))
      AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND cipher=? AND status='active')`,
      )
      .bind(updated.generation, Date.now(), c.id, c.id, updated.generation, cipher),
    runtime.db
      .prepare(
        `UPDATE payment_provider_jobs SET status='cancelled',reason='connection_generation_changed',lease_token=NULL,lease_until=0,wake_token=NULL,wake_until=0,updated_at=?
      WHERE connection_id=? AND kind!='webhook' AND status IN ('queued','running','paused') AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND cipher=? AND status='active')`,
      )
      .bind(Date.now(), c.id, c.id, updated.generation, cipher),
  ]);
  if (!results[0].meta.changes) throw new ProviderError('connection_generation_changed', 409);
  const recovered = await runtime.db
    .prepare(
      "SELECT * FROM payment_provider_jobs WHERE connection_id=? AND generation=? AND status='queued' ORDER BY created_at,id LIMIT 1",
    )
    .bind(c.id, updated.generation)
    .first<import('./payment-provider-model.js').JobRow>();
  if (recovered) await dispatchProviderJob(runtime, recovered);
  return publicConnection(updated, await connectionRules(runtime.db, c.id));
}
export async function verifyConnection(runtime: ProviderRuntime, c: ConnectionRow) {
  await activeConnection(runtime.db, c.id, c.generation);
  const credentials = await openProviderCredentials(runtime.keyring, c, c.cipher);
  validateProviderKeyring(runtime.keyring);
  const account = await verifyProviderAccount(verificationInput(c, credentials), runtime.fetcher);
  if (account !== c.account_id) throw new ProviderError('provider_account_mismatch', 409);
  const verified = await runtime.db
    .prepare(
      `UPDATE payment_connections SET verified_at=? WHERE id=? AND generation=? AND status='active'`,
    )
    .bind(Date.now(), c.id, c.generation)
    .run();
  if (!verified.meta.changes) throw new ProviderError('connection_generation_changed', 409);
  return { verified: true, webhook_received: c.webhook_at !== null };
}
export async function disconnectProvider(runtime: ProviderRuntime, c: ConnectionRow) {
  const results = await runtime.db.batch([
    runtime.db
      .prepare(
        `UPDATE payment_connections SET status='disconnected',cipher=NULL,generation=generation+1 WHERE id=? AND generation=?`,
      )
      .bind(c.id, c.generation),
    runtime.db
      .prepare(
        `UPDATE payment_provider_jobs SET status='cancelled',reason='connection_disconnected',lease_token=NULL,lease_until=0,wake_token=NULL,wake_until=0 WHERE connection_id=? AND generation=? AND status IN ('queued','running','paused') AND EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='disconnected')`,
      )
      .bind(c.id, c.generation, c.id, c.generation + 1),
  ]);
  if (!results[0].meta.changes) throw new ProviderError('connection_generation_changed', 409);
  return { disconnected: true, retained_financial_facts: true };
}
