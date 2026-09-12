import type { AnalyticsShare, SharedAnalytics } from '@app-health/contracts';
import {
  D1AnalyticsShareStore,
  MemoryAnalyticsShareStore,
  AnalyticsShareLimitError,
  type ShareRecord,
  type ShareScope,
} from './analytics-share-store.js';
import { sharedBrowserMetrics, type BrowserEnvironment } from './browser-routes.js';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
const localStore = new MemoryAnalyticsShareStore();
const storeFor = (env: BrowserEnvironment, local: boolean) => {
  if (local) return localStore;
  if (!env.DB) throw new Error('Sharing storage unavailable');
  return new D1AnalyticsShareStore(env.DB);
};
const json = (status: number, value: unknown) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      vary: 'Authorization',
    },
  });
const descriptor = (share: ShareRecord): AnalyticsShare => ({
  id: share.id,
  app_id: share.app_id,
  environment_id: share.environment_id,
  created_at: share.created_at,
  revoked_at: share.revoked_at,
});

/** Share tokens never pass through the owner or ingestion authentication adapters. */
export async function handlePublicAnalytics(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/v1/shared/analytics') return null;
  const response =
    request.method === 'OPTIONS'
      ? new Response(null, { status: 204 })
      : await publicRead(request, env, repos, local);
  // These aggregate reads use revocable bearer links, never session cookies.
  // CORS belongs only to this public endpoint, including revoked/error replies.
  response.headers.set('access-control-allow-origin', '*');
  response.headers.set('access-control-allow-methods', 'GET, OPTIONS');
  response.headers.set('access-control-allow-headers', 'Authorization');
  response.headers.set('access-control-max-age', '600');
  return response;
}
async function publicRead(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  if (request.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const match = /^Bearer (ahs_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
  if (!match) return json(404, { error: 'This analytics link is unavailable.' });
  try {
    // Deliberately uncached. Revocation is checked before every public metrics read.
    const share = await storeFor(env, local).resolve(match[1]);
    if (!share) return json(404, { error: 'This analytics link is unavailable.' });
    const project = local ? await localProject(repos, share) : await publicProject(env, share);
    if (!project) return json(404, { error: 'This analytics link is unavailable.' });
    const metrics = await sharedBrowserMetrics(share, env, local);
    const response: SharedAnalytics = {
      project,
      ...metrics,
    };
    return json(200, response);
  } catch {
    return json(503, { error: 'Live analytics is temporarily unavailable.' });
  }
}
async function localProject(
  repos: AppHealthRepositories,
  share: ShareRecord,
): Promise<{ name: string; environment: string } | null> {
  const [app, environment] = await Promise.all([
    repos.apps.getApp(share.app_id),
    repos.environments.getEnvironment(share.environment_id),
  ]);
  return app && environment?.app_id === app.id
    ? { name: app.name, environment: environment.name }
    : null;
}
async function publicProject(
  env: BrowserEnvironment,
  share: ShareRecord,
): Promise<{ name: string; environment: string } | null> {
  const row = await env.DB?.prepare(
    `SELECT apps.name AS app_name, environments.name AS environment_name
    FROM workspace_apps
    JOIN apps ON apps.id = workspace_apps.app_id
    JOIN environments ON environments.id = ? AND environments.app_id = apps.id
    WHERE workspace_apps.app_id = ? AND workspace_apps.workspace_id = ?`,
  )
    .bind(share.environment_id, share.app_id, share.workspace)
    .first<{ app_name: string; environment_name: string }>();
  return row ? { name: row.app_name, environment: row.environment_name } : null;
}

function ownerMayShare(owner: OwnerIdentity, local: boolean, app: string): boolean {
  return (
    !owner.appId && (local || !!owner.workspaceId) && (!owner.appIds || owner.appIds.includes(app))
  );
}
function shareMutationAllowed(request: Request, url: URL): boolean {
  return (
    request.method === 'GET' ||
    !request.headers.has('origin') ||
    request.headers.get('origin') === url.origin
  );
}

export async function handleAnalyticsShareOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/analytics/shares') return null;
  if (!['GET', 'POST', 'DELETE'].includes(request.method))
    return json(405, { error: 'Method not allowed' });
  if (!shareMutationAllowed(request, url))
    return json(403, { error: 'Same-origin request required' });
  const app = url.searchParams.get('app_id') ?? '';
  const environment = url.searchParams.get('environment_id') ?? '';
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(app) || !/^[a-zA-Z0-9-]{1,100}$/.test(environment))
    return json(400, { error: 'Project and environment are required' });
  if (!ownerMayShare(owner, local, app)) return json(403, { error: 'Project access denied' });
  try {
    const record = await repos.environments.getEnvironment(environment);
    if (record?.app_id !== app) return json(404, { error: 'Environment not found' });
    const scope = {
      workspace: local ? 'local' : owner.workspaceId!,
      app_id: app,
      environment_id: environment,
    };
    return await shareOperation(request, scope, env, local);
  } catch {
    return json(503, { error: 'Share links are temporarily unavailable.' });
  }
}
async function shareOperation(
  request: Request,
  scope: ShareScope,
  env: BrowserEnvironment,
  local: boolean,
): Promise<Response> {
  const store = storeFor(env, local);
  if (request.method === 'GET')
    return json(200, { shares: (await store.list(scope)).map(descriptor) });
  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id') ?? '';
    return (await store.revoke(scope, id))
      ? json(200, { revoked: true })
      : json(404, { error: 'Share link not found' });
  }
  try {
    const created = await store.create(scope);
    return json(201, { share: descriptor(created.share), token: created.token });
  } catch (error) {
    if (error instanceof AnalyticsShareLimitError)
      return json(409, {
        error: 'Five active links already exist. Revoke one before creating another.',
      });
    throw error;
  }
}
