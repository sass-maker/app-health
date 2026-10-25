import { dispatchProviderJob } from './payment-provider-wake.js';
import {
  PaymentConnectionInput,
  PaymentCredentials,
  PaymentImportInput,
  PaymentRoutingInput,
  PaymentScopeV1,
  RevenueQueryV1,
} from '@app-health/contracts';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
import { readPublicJson } from './public-body.js';
import { ownerRouteAllowed } from './access-policy.js';
import {
  createProviderConnection,
  replaceProviderCredentials,
  verifyConnection,
  disconnectProvider,
} from './payment-provider-connections.js';
import {
  connectionRow,
  connectionRules,
  jobRow,
  listConnections,
  publicConnection,
  publicJob,
} from './payment-provider-store.js';
import { providerScopeAllowed, saveRouting } from './payment-provider-routing.js';
import {
  startProviderImport,
  resumeProviderJob,
  cancelProviderJob,
} from './payment-provider-jobs.js';
import { providerRevenueReport } from './payment-provider-report.js';
import { localProviderRequest } from './payment-provider-local.js';
import {
  ProviderError,
  providerRuntime,
  type ConnectionRow,
  type ProviderEnvironment,
  type ProviderRuntime,
} from './payment-provider-model.js';

type Scope = import('@app-health/contracts').PaymentScopeV1;
type Context = {
  request: Request;
  url: URL;
  env: ProviderEnvironment;
  owner: OwnerIdentity;
  repos: AppHealthRepositories;
  local: boolean;
  waitUntil?: (promise: Promise<unknown>) => void;
};
const json = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', vary: 'Authorization, X-App-Health-Workspace' },
  });
async function allowed(context: Context, scope: Scope) {
  const { owner, repos, env, local } = context;
  if (owner.appId || (owner.appIds && !owner.appIds.includes(scope.app_id))) return false;
  if (
    (await repos.environments.getEnvironment(scope.environment_id))?.app_id !== scope.app_id ||
    !(await repos.apps.getApp(scope.app_id))
  )
    return false;
  if (
    owner.apiScopes &&
    !owner.apiScopes.some(
      (s) => s.app_id === scope.app_id && s.environment_id === scope.environment_id,
    )
  )
    return false;
  if (local) return true;
  if (!env.DB) return false;
  if (owner.workspaceId) return providerScopeAllowed(env.DB, scope, owner.workspaceId);
  return !(await env.DB.prepare('SELECT 1 FROM workspace_apps WHERE app_id=?')
    .bind(scope.app_id)
    .first());
}
function runtime(context: Context): ProviderRuntime {
  return providerRuntime(context.env);
}

function requireMethod(context: Context, expected: string) {
  if (context.request.method !== expected) throw new ProviderError('method_not_allowed', 405);
}
async function credentialAction(context: Context, c: ConnectionRow) {
  const credentials = PaymentCredentials.safeParse(await readPublicJson(context.request, 32768));
  if (!credentials.success) throw new ProviderError('invalid_provider_credentials');
  return json(200, await replaceProviderCredentials(runtime(context), c, credentials.data));
}
async function routingAction(context: Context, c: ConnectionRow) {
  const routing = PaymentRoutingInput.safeParse(await readPublicJson(context.request, 32768));
  if (!routing.success) throw new ProviderError('invalid_provider_routing');
  for (const rule of routing.data.rules)
    if (!(await allowed(context, rule)))
      throw new ProviderError('routing_destination_forbidden', 403);
  await saveRouting(runtime(context).db, c, routing.data);
  return json(200, publicConnection({ ...c, routing: routing.data.routing }, routing.data.rules));
}
async function importAction(context: Context, c: ConnectionRow, action: string) {
  const input = PaymentImportInput.safeParse(await readPublicJson(context.request, 1024));
  if (!input.success) throw new ProviderError('invalid_import_interval');
  const r = runtime(context),
    job = await startProviderImport(
      r,
      c,
      input.data,
      action === 'reconcile' ? 'reconcile' : 'import',
    );
  await dispatchProviderJob(r, await jobRow(r.db, job.id));
  return json(202, job);
}
async function jobsAction(context: Context, c: ConnectionRow) {
  const jobs = await runtime(context)
    .db.prepare(
      'SELECT * FROM payment_provider_jobs WHERE connection_id=? ORDER BY created_at DESC LIMIT 20',
    )
    .bind(c.id)
    .all<import('./payment-provider-model.js').JobRow>();
  return json(200, { jobs: jobs.results.map(publicJob) });
}
async function connectionAction(context: Context, c: ConnectionRow, action: string | null) {
  const method =
    action === 'routing' ? 'PUT' : action === 'jobs' ? 'GET' : action === null ? 'DELETE' : 'POST';
  requireMethod(context, method);
  switch (action) {
    case null:
      return json(200, await disconnectProvider(runtime(context), c));
    case 'verify':
      return json(200, await verifyConnection(runtime(context), c));
    case 'credentials':
      return credentialAction(context, c);
    case 'routing':
      return routingAction(context, c);
    case 'imports':
    case 'reconcile':
      return importAction(context, c, action);
    case 'jobs':
      return jobsAction(context, c);
    default:
      throw new ProviderError('not_found', 404);
  }
}
async function reportRequest(context: Context) {
  requireMethod(context, 'GET');
  const query = RevenueQueryV1.safeParse(Object.fromEntries(context.url.searchParams));
  if (!query.success) throw new ProviderError('invalid_provider_revenue_query');
  if (!(await allowed(context, query.data)))
    throw new ProviderError('provider_scope_forbidden', 403);
  if (context.local) return localProviderRequest(context.request, context.url, query.data);
  return json(200, await providerRevenueReport(runtime(context).db, query.data));
}
async function managementScope(context: Context) {
  if (
    context.owner.authKind === 'api-token' ||
    context.owner.workspaceRole === 'viewer' ||
    context.owner.appId
  )
    throw new ProviderError('provider_configuration_role_forbidden', 403);
  const scope = PaymentScopeV1.safeParse({
    app_id: context.url.searchParams.get('app_id'),
    environment_id: context.url.searchParams.get('environment_id'),
  });
  if (!scope.success) throw new ProviderError('provider_scope_required');
  if (!(await allowed(context, scope.data)))
    throw new ProviderError('provider_scope_forbidden', 403);
  return scope.data;
}
async function connectionCollection(context: Context, scope: Scope) {
  const r = runtime(context);
  if (context.request.method === 'GET')
    return json(200, { fixture_mode: false, connections: await listConnections(r.db, scope) });
  requireMethod(context, 'POST');
  const input = PaymentConnectionInput.safeParse(await readPublicJson(context.request, 32768));
  if (
    !input.success ||
    input.data.app_id !== scope.app_id ||
    input.data.environment_id !== scope.environment_id
  )
    throw new ProviderError('invalid_connection_or_scope');
  return json(
    201,
    await createProviderConnection(r, context.owner.workspaceId ?? 'legacy', input.data),
  );
}
async function connectionRequest(context: Context, scope: Scope) {
  const match =
    /^\/v1\/payment-connections\/([a-f0-9-]{36})(?:\/(credentials|verify|routing|imports|reconcile|jobs))?$/.exec(
      context.url.pathname,
    );
  if (!match) throw new ProviderError('not_found', 404);
  const r = runtime(context),
    c = await connectionRow(r.db, match[1]);
  assertConnectionScope(c, scope, context.owner);
  if (!match[2] && context.request.method === 'GET')
    return json(200, publicConnection(c, await connectionRules(r.db, c.id)));
  return connectionAction(context, c, match[2] ?? null);
}
async function ownerRequest(context: Context) {
  if (!ownerRouteAllowed(context.request, context.owner))
    throw new ProviderError('provider_route_role_forbidden', 403);
  if (context.url.pathname === '/v1/analytics/provider-revenue') return reportRequest(context);
  const scope = await managementScope(context);
  if (context.local) return localProviderRequest(context.request, context.url, scope);
  if (context.url.pathname === '/v1/payment-connections')
    return connectionCollection(context, scope);
  const job = /^\/v1\/payment-imports\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/.exec(
    context.url.pathname,
  );
  return job ? jobRequest(context, job[1], job[2], scope) : connectionRequest(context, scope);
}
function assertConnectionScope(c: ConnectionRow, scope: Scope, owner: OwnerIdentity) {
  if (
    c.app_id !== scope.app_id ||
    c.environment_id !== scope.environment_id ||
    c.workspace_id !== (owner.workspaceId ?? 'legacy')
  )
    throw new ProviderError('provider_connection_scope_forbidden', 403);
}
async function jobRequest(context: Context, id: string, action: string | undefined, scope: Scope) {
  const r = runtime(context),
    job = await jobRow(r.db, id),
    c = await connectionRow(r.db, job.connection_id);
  assertConnectionScope(c, scope, context.owner);
  if (action === 'cancel' && context.request.method === 'POST')
    return json(200, await cancelProviderJob(r, job));
  if (action === 'resume' && context.request.method === 'POST') await resumeProviderJob(r, job);
  else if (action || context.request.method !== 'GET')
    throw new ProviderError('method_not_allowed', 405);
  if (action === 'resume') await dispatchProviderJob(r, await jobRow(r.db, id));
  return json(200, publicJob(await jobRow(r.db, id)));
}
export async function handleProviderOwner(
  request: Request,
  env: ProviderEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  options: { local: boolean; waitUntil?: Context['waitUntil'] },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !['/v1/payment-connections', '/v1/payment-imports', '/v1/analytics/provider-revenue'].some(
      (path) => url.pathname === path || url.pathname.startsWith(path + '/'),
    )
  )
    return null;
  try {
    return await ownerRequest({ request, url, env, owner, repos, ...options });
  } catch (error) {
    const status =
      error instanceof ProviderError
        ? error.code === 'provider_credentials_or_permissions_rejected'
          ? 424
          : error.status
        : error instanceof SyntaxError
          ? 400
          : 503;
    return json(status, {
      error: error instanceof ProviderError ? error.code : 'provider_operation_unavailable',
    });
  }
}
