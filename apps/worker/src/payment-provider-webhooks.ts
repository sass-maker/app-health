import {
  verifyStripePaymentSignature,
  verifyStandardPaymentSignature,
} from './payments-signatures.js';
import { openProviderCredentials } from './payment-provider-crypto.js';
import { connectionRow } from './payment-provider-store.js';
import {
  object,
  ProviderError,
  resourceId,
  type ConnectionRow,
  type ProviderEnvironment,
  type ProviderRuntime,
  type Resource,
} from './payment-provider-model.js';

async function rawBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ProviderError('webhook_body_required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.length;
    if (size > 262144) {
      await reader.cancel();
      throw new ProviderError('webhook_body_too_large', 413);
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
function reference(c: ConnectionRow, payload: Resource) {
  const type = String(payload.type ?? '');
  const data = object(c.provider === 'stripe' ? object(payload.data).object : payload.data);
  const refund =
    c.provider === 'stripe' ? /^(refund\.|charge\.refund\.)/.test(type) : /^refund\./.test(type);
  const payment =
    c.provider === 'stripe'
      ? /^charge\.(succeeded|updated|captured|refunded)$/.test(type)
      : /^(order|payment)\.(paid|succeeded|updated|created)$/.test(type);
  if (!refund && !payment) return null;
  const id = c.provider === 'dodo' ? data[refund ? 'refund_id' : 'payment_id'] : data.id;
  if (c.provider === 'stripe' && payload.livemode !== (c.mode === 'live'))
    throw new ProviderError('webhook_mode_mismatch', 409);
  if (c.provider === 'stripe' && payload.account !== undefined && payload.account !== c.account_id)
    throw new ProviderError('webhook_account_mismatch', 409);
  return { kind: refund ? 'refund' : 'payment', id: resourceId(id) };
}
function webhookJson(bytes: Uint8Array): Resource {
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new ProviderError('invalid_webhook_json');
  }
}
async function validSignature(
  request: Request,
  c: ConnectionRow,
  bytes: Uint8Array,
  credentials: Awaited<ReturnType<typeof openProviderCredentials>>,
  now: number,
) {
  return c.provider === 'stripe'
    ? await verifyStripePaymentSignature({
        body: bytes,
        now,
        signature: request.headers.get('stripe-signature') ?? '',
        secrets: credentials.webhook_secrets,
      })
    : await verifyStandardPaymentSignature({
        body: bytes,
        now,
        id: request.headers.get('webhook-id') ?? '',
        timestamp: request.headers.get('webhook-timestamp') ?? '',
        signature: request.headers.get('webhook-signature') ?? '',
        secrets: credentials.webhook_secrets.map((value) => ({
          value,
          scheme: c.provider === 'polar' ? credentials.signature_scheme : 'standard',
        })),
      });
}
async function acceptWebhook(request: Request, runtime: ProviderRuntime, c: ConnectionRow) {
  if (c.status !== 'active' || !c.cipher)
    throw new ProviderError('payment_connection_disconnected', 410);
  const bytes = await rawBody(request);
  const credentials = await openProviderCredentials(runtime.master, c, c.cipher);
  const now = Date.now();
  const valid = await validSignature(request, c, bytes, credentials, now);
  if (!valid) throw new ProviderError('invalid_webhook_signature', 401);
  const payload = webhookJson(bytes);
  const delivery = resourceId(
    c.provider === 'stripe' ? payload.id : request.headers.get('webhook-id'),
  );
  const ref = reference(c, payload);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const id = crypto.randomUUID();
  return persistWebhook(runtime, c, { id, delivery, digest, ref, now });
}
async function persistWebhook(
  runtime: ProviderRuntime,
  c: ConnectionRow,
  work: {
    id: string;
    delivery: string;
    digest: string;
    ref: ReturnType<typeof reference>;
    now: number;
  },
) {
  const { id, delivery, digest, ref, now } = work;
  const results = await runtime.db.batch([
    runtime.db
      .prepare(
        `INSERT OR IGNORE INTO payment_provider_jobs(id,connection_id,generation,kind,status,phase,from_time,to_time,resource_kind,resource_id,delivery_id,body_digest,created_at,updated_at)
      SELECT ?,?,?,'webhook',?,?,0,0,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM payment_connections WHERE id=? AND generation=? AND status='active' AND cipher IS NOT NULL)
      AND (SELECT COUNT(*) FROM payment_provider_jobs WHERE connection_id=? AND status IN ('queued','running'))<1000`,
      )
      .bind(
        id,
        c.id,
        c.generation,
        ref ? 'queued' : 'finished',
        ref ? 'resource' : 'done',
        ref?.kind ?? null,
        ref?.id ?? null,
        delivery,
        digest,
        now,
        now,
        c.id,
        c.generation,
        c.id,
      ),
    runtime.db
      .prepare(
        `UPDATE payment_connections SET webhook_at=? WHERE id=? AND generation=? AND status='active'`,
      )
      .bind(now, c.id, c.generation),
    runtime.db
      .prepare(
        'SELECT id FROM payment_provider_jobs WHERE connection_id=? AND delivery_id=? AND body_digest=?',
      )
      .bind(c.id, delivery, digest),
  ]);
  if (!results[2].results?.length)
    throw new ProviderError('webhook_capacity_or_connection_changed', 429);
  return {
    accepted: true,
    duplicate: !results[0].meta.changes,
    job_id: String(results[2].results[0].id),
  };
}
export async function handleProviderWebhook(
  request: Request,
  env: ProviderEnvironment,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/v1\/payment-webhooks\/(stripe|polar|dodo)\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!match) return null;
  const denied = webhookRequestDenial(request, env, local, url);
  if (denied) return denied;
  try {
    if (!env.DB || !env.OWNER_AUTH_TOKEN)
      throw new ProviderError('provider_storage_or_encryption_unavailable', 503);
    const c = await connectionRow(env.DB, match[2]);
    if (c.provider !== match[1]) throw new ProviderError('payment_connection_not_found', 404);
    const result = await acceptWebhook(request, { db: env.DB, master: env.OWNER_AUTH_TOKEN }, c);
    return Response.json(result, { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const conflict =
      error instanceof Error && error.message.includes('payment webhook identity conflict');
    const status = conflict ? 409 : error instanceof ProviderError ? error.status : 503;
    const message = conflict
      ? 'webhook_delivery_identity_conflict'
      : error instanceof ProviderError
        ? error.code
        : 'webhook_storage_unavailable';
    return Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });
  }
}

function webhookRequestDenial(
  request: Request,
  env: ProviderEnvironment,
  local: boolean,
  url: URL,
) {
  if (local)
    return Response.json({ error: 'local_fixtures_do_not_accept_real_webhooks' }, { status: 409 });
  if (url.hostname !== env.APP_HEALTH_INGEST_HOST || url.hostname.endsWith('.workers.dev'))
    return new Response(null, { status: 404 });
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.has('origin')) return new Response(null, { status: 403 });
  return null;
}
