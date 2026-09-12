import { NativeBatchV1, type NativeKey } from '@app-health/contracts';
import {
  D1NativeKeyStore,
  MemoryNativeKeyStore,
  NativeKeyLimitError,
  type NativeScope,
} from './native-key-store.js';
import { acceptBrowser, type BrowserEnvironment } from './browser-routes.js';
import { readPublicJson } from './public-body.js';
import type { AppHealthRepositories } from './repository.js';
import type { OwnerIdentity } from './identity.js';

const memory = new MemoryNativeKeyStore();
function store(env: BrowserEnvironment, local: boolean) {
  if (local) return memory;
  if (!env.DB) throw new Error('Native key storage unavailable');
  return new D1NativeKeyStore(env.DB);
}
const json = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', vary: 'Authorization' },
  });
async function currentScope(
  scope: NativeScope,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  if (local)
    return (await repos.environments.getEnvironment(scope.environment_id))?.app_id === scope.app_id;
  return !!(await env.DB?.prepare(
    `SELECT environments.id FROM environments
    JOIN workspace_apps ON workspace_apps.app_id = environments.app_id
    WHERE environments.id = ? AND environments.app_id = ? AND workspace_apps.workspace_id = ?`,
  )
    .bind(scope.environment_id, scope.app_id, scope.workspace_id)
    .first());
}

function nativeMutationAllowed(request: Request, url: URL) {
  const origin = request.headers.get('origin');
  return request.method === 'GET' || !origin || origin === url.origin;
}
function nativeOwnerAllowed(owner: OwnerIdentity, local: boolean, app: string) {
  return (
    !owner.appId && (local || !!owner.workspaceId) && (!owner.appIds || owner.appIds.includes(app))
  );
}
function validScopeIds(app: string, environment: string) {
  return /^[a-zA-Z0-9-]{1,100}$/.test(app) && /^[a-zA-Z0-9-]{1,100}$/.test(environment);
}
export async function handleNativeKeyOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/native-keys') return null;
  if (!['GET', 'POST', 'DELETE'].includes(request.method))
    return json(405, { error: 'Method not allowed' });
  if (!nativeMutationAllowed(request, url))
    return json(403, { error: 'Same-origin request required' });
  const app = url.searchParams.get('app_id') ?? '';
  const environment = url.searchParams.get('environment_id') ?? '';
  if (!validScopeIds(app, environment))
    return json(400, { error: 'Project and environment required' });
  if (!nativeOwnerAllowed(owner, local, app)) return json(403, { error: 'Project access denied' });
  const scope = {
    workspace_id: local ? 'local' : owner.workspaceId!,
    app_id: app,
    environment_id: environment,
  };
  try {
    if (!(await currentScope(scope, env, repos, local)))
      return json(404, { error: 'Environment not found' });
    return await nativeKeyAction(request, url, scope, store(env, local));
  } catch (cause) {
    return json(cause instanceof NativeKeyLimitError ? 409 : 503, {
      error: cause instanceof NativeKeyLimitError ? cause.message : 'Native keys unavailable',
    });
  }
}
async function nativeKeyAction(
  request: Request,
  url: URL,
  scope: NativeScope,
  keys: ReturnType<typeof store>,
) {
  if (request.method === 'GET') return json(200, { keys: await keys.list(scope) });
  if (request.method === 'POST') return json(201, await keys.create(scope));
  const id = url.searchParams.get('id') ?? '';
  return (await keys.revoke(scope, id))
    ? json(200, { revoked: true })
    : json(404, { error: 'Key not found' });
}

function validTimes(batch: NativeBatchV1, now: number) {
  return (
    batch.events.every(
      (event) => event.timestamp >= now - 86400000 && event.timestamp <= now + 60000,
    ) &&
    batch.logs.every((log) => log.timestamp >= now - 30 * 86400000 && log.timestamp <= now + 300000)
  );
}
async function deliverNative(
  input: NativeBatchV1,
  key: NativeKey,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  if (input.events.length || input.active) {
    const response = await acceptBrowser(
      {
        workspace: key.workspace_id,
        app_id: key.app_id,
        environment_id: key.environment_id,
        batch_id: input.batch_id,
        received_at: Date.now(),
        events: input.events.map((event) => ({
          event_id: event.event_id,
          timestamp: event.timestamp,
          type: 'event',
          name: event.name,
          path: event.screen ? `/screens/${event.screen}` : '/',
          referrer: '',
        })),
      },
      input.active ? input.session_id : undefined,
      env,
      repos,
      local,
    );
    if (response.status !== 202) return response;
  }
  if (input.logs.length) {
    if (!repos.logs) return json(503, { error: 'Logs unavailable' });
    await repos.logs.recordLogs(key.app_id, key.environment_id, input.logs, 'native');
    await repos.capabilities?.recordCapability(key.app_id, key.environment_id, 'logs', Date.now());
  }
  return json(202, { accepted: input.events.length + input.logs.length, source: 'native' });
}
async function collectNative(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  const parsed = NativeBatchV1.safeParse(await readPublicJson(request, 65536));
  if (!parsed.success || !validTimes(parsed.data, Date.now()))
    return json(400, { error: 'Invalid native batch' });
  const key = await store(env, local).resolve(parsed.data.public_key);
  if (!key || !(await currentScope(key, env, repos, local)))
    return json(403, { error: 'Native key rejected' });
  const total = parsed.data.events.length + parsed.data.logs.length;
  const used = await repos.publicKeys?.consumeBrowserQuota(
    `native:${key.id}`,
    Math.floor(Date.now() / 60000) * 60000,
    Math.max(1, total),
  );
  if (used === undefined) return json(503, { error: 'Native quota unavailable' });
  if (used > 600) return json(429, { error: 'Native quota exceeded' });
  return deliverNative(parsed.data, key, env, repos, local);
}
export async function handleNativeIngest(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/native') return null;
  if (!local && url.hostname !== env.APP_HEALTH_INGEST_HOST)
    return json(404, { error: 'Not found' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (request.headers.has('origin'))
    return json(403, { error: 'Use a browser key for browser requests' });
  try {
    return await collectNative(request, env, repos, local);
  } catch (cause) {
    const status =
      cause instanceof SyntaxError
        ? 400
        : cause instanceof Error && cause.message === 'payload too large'
          ? 413
          : 503;
    return json(status, {
      error:
        status === 503
          ? 'Native collector unavailable; retry this batch'
          : 'Invalid native payload',
    });
  }
}
