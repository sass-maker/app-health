import { ProductBatchV1, type ProductEventV1 } from '@app-health/contracts';
import type { AppHealthRepositories } from './repository.js';
import { readPublicJson } from './public-body.js';
import { acceptProductArchive } from './product-event-archive.js';
import { localProductEvents } from './product-event-local.js';
import {
  normalizedProductEvents,
  productFailure,
  ProductError,
  type ProductScope,
  type ProductEnvironment,
} from './product-event-model.js';

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
function environmentMatches(
  e: { id: string; name: string },
  input: ProductBatchV1,
  scopedId: string | null,
) {
  if (input.environment_id) return e.id === input.environment_id;
  if (scopedId) return e.id === scopedId;
  return e.name === (input.environment ?? 'production');
}
async function productScope(
  request: Request,
  repos: AppHealthRepositories,
  local: boolean,
  input: ProductBatchV1,
): Promise<ProductScope> {
  const raw = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';
  const key = raw ? await repos.keys.verifyKey(raw) : null;
  if (!key) throw new ProductError('Invalid or revoked private server key', 401);
  const environments = await repos.environments.listEnvironments(key.app_id);
  const environment = environments.find((e) => environmentMatches(e, input, key.environment_id));
  if (
    !environment ||
    (key.environment_id !== null && key.environment_id !== environment.id) ||
    (input.environment !== undefined && input.environment !== environment.name)
  )
    throw new ProductError('Private key environment scope forbidden', 403);
  const owner = local
    ? { workspace_id: 'local' }
    : await (repos as AppHealthRepositories).apps.getApp(key.app_id);
  if (!owner) throw new ProductError('Product unavailable', 403);
  return { workspace: '', app_id: key.app_id, environment_id: environment.id, channel: 'server' };
}
function validTimes(events: ProductEventV1[]) {
  const now = Date.now();
  return events.every((e) => e.occurred_at >= now - 86400000 && e.occurred_at <= now + 60000);
}
async function accept(
  request: Request,
  env: ProductEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  const parsed = ProductBatchV1.safeParse(await readPublicJson(request, 65536));
  if (!parsed.success)
    throw new ProductError('Invalid canonical product batch (1–100 events, 64 KiB maximum)', 400);
  if (!validTimes(parsed.data.events))
    throw new ProductError(
      'Product events must be within the last 24 hours and at most 60 seconds in the future',
      400,
    );
  const scope = await productScope(request, repos, local, parsed.data);
  const workspace = local
    ? { workspace_id: 'local' }
    : await env.DB?.prepare('SELECT workspace_id FROM workspace_apps WHERE app_id=?')
        .bind(scope.app_id)
        .first<{ workspace_id: string }>();
  if (!workspace)
    throw new ProductError('Server product events require an account-owned project', 409);
  scope.workspace = workspace.workspace_id;
  const events = await normalizedProductEvents(scope, parsed.data.events);
  if (local) return json(202, localProductEvents.record(scope, parsed.data.batch_id, events));
  if (!env.DB || !env.BROWSER_HISTORY?.get)
    throw new ProductError('Product archive bindings unavailable');
  return json(
    202,
    await acceptProductArchive(
      env.DB,
      {
        put: env.BROWSER_HISTORY.put.bind(env.BROWSER_HISTORY),
        get: env.BROWSER_HISTORY.get.bind(env.BROWSER_HISTORY),
      },
      scope,
      parsed.data.batch_id,
      events,
    ),
  );
}
export async function handleProductEventIngest(
  request: Request,
  env: ProductEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/product-events') return null;
  if (
    !local &&
    (url.hostname !== env.APP_HEALTH_INGEST_HOST || url.hostname.endsWith('.workers.dev'))
  )
    return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (request.headers.has('origin')) return json(403, { error: 'Private server ingestion only' });
  try {
    return await accept(request, env, repos, local);
  } catch (error) {
    if (error instanceof Error && error.message === 'payload too large')
      return json(413, { error: 'Product batch exceeds 64 KiB' });
    if (error instanceof SyntaxError) return json(400, { error: 'Invalid JSON' });
    const failure = productFailure(error);
    return json(failure.status, { error: failure.message });
  }
}
