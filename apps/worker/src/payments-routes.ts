import { PaymentIngestV1, RevenueQueryV1 } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
import { readPublicJson } from './public-body.js';
import { LocalPaymentLedger } from './payments-local.js';
import { D1PaymentLedger } from './payments-store.js';
import { PaymentCapacityError, PaymentConflictError } from './payments-model.js';

interface PaymentEnvironment {
  DB?: D1DatabaseLike;
  APP_HEALTH_INGEST_HOST?: string;
}

const localLedger = new LocalPaymentLedger();
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', vary: 'Authorization' } });

function ledger(env: PaymentEnvironment, local: boolean) {
  if (local) return localLedger;
  if (!env.DB) throw new Error('Financial storage unavailable');
  return new D1PaymentLedger(env.DB);
}

function failure(error: unknown): Response {
  if (error instanceof PaymentConflictError) return json(409, { error: error.message });
  if (error instanceof PaymentCapacityError) return json(413, { error: error.message });
  if (error instanceof SyntaxError) return json(400, { error: 'Invalid JSON' });
  if (error instanceof Error && error.message === 'payload too large')
    return json(413, { error: 'Financial request exceeds 16 KiB' });
  return json(503, { error: 'Financial ledger unavailable; no acceptance or totals are claimed' });
}

async function acceptPayment(
  request: Request,
  repos: AppHealthRepositories,
  env: PaymentEnvironment,
  local: boolean,
) {
  const rawKey = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const key = rawKey ? await repos.keys.verifyKey(rawKey) : null;
  if (!key) return json(401, { error: 'Invalid or revoked private server key' });
  const parsed = PaymentIngestV1.safeParse(await readPublicJson(request, 16384));
  if (!parsed.success) return json(400, { error: 'Invalid versioned financial fact' });
  const input = parsed.data;
  const environment = await repos.environments.getEnvironment(input.environment_id);
  if (
    input.app_id !== key.app_id ||
    (key.environment_id !== null && key.environment_id !== input.environment_id) ||
    environment?.app_id !== key.app_id
  )
    return json(403, { error: 'Private key project or environment scope forbidden' });
  if (input.namespace.provider !== 'custom')
    return json(403, { error: 'Generic ingestion requires the custom provider namespace' });
  if (input.fact.occurred_at > Date.now() + 300_000)
    return json(400, { error: 'Financial occurrence time is in the future' });
  const recorded = await ledger(env, local).record(input);
  return json(202, { schema_version: 1, recorded, duplicate: !recorded });
}

export async function handlePaymentIngest(
  request: Request,
  env: PaymentEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/payments') return null;
  if (
    !local &&
    (url.hostname !== env.APP_HEALTH_INGEST_HOST || url.hostname.endsWith('.workers.dev'))
  )
    return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (request.headers.has('origin')) return json(403, { error: 'Private server ingestion only' });
  try {
    return await acceptPayment(request, repos, env, local);
  } catch (error) {
    return failure(error);
  }
}

async function reportAllowed(
  query: RevenueQueryV1,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  env: PaymentEnvironment,
) {
  if (
    (owner.appId && owner.appId !== query.app_id) ||
    (owner.appIds && !owner.appIds.includes(query.app_id))
  )
    return false;
  if ((await repos.environments.getEnvironment(query.environment_id))?.app_id !== query.app_id)
    return false;
  if (owner.workspaceId) {
    const membership = await env.DB?.prepare(
      'SELECT app_id FROM workspace_apps WHERE app_id = ? AND workspace_id = ?',
    )
      .bind(query.app_id, owner.workspaceId)
      .first();
    if (!membership) return false;
  }
  return true;
}

export async function handlePaymentOwner(
  request: Request,
  env: PaymentEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/analytics/revenue') return null;
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const query = RevenueQueryV1.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return json(400, { error: 'Invalid bounded revenue query' });
  try {
    if (!(await reportAllowed(query.data, owner, repos, env)))
      return json(403, { error: 'Revenue project, workspace or environment scope forbidden' });
    return json(200, await ledger(env, local).report(query.data));
  } catch (error) {
    return failure(error);
  }
}
