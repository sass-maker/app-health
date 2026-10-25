import {
  AnalysisDefinition,
  AnalysisQuery,
  AnalysisScope,
  type AnalysisScope as Scope,
} from '@app-health/contracts';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
import { localConversionBatches, type BrowserEnvironment } from './browser-routes.js';
import {
  LocalAnalysisStore,
  D1AnalysisStore,
  type AnalysisStoreScope,
  type AnalysisStore,
} from './analysis-store.js';
import { evaluateConversions } from './conversion-evaluator.js';
import { readConversionArchive } from './conversion-archive.js';
import { readPublicJson } from './public-body.js';

const localStore = new LocalAnalysisStore();
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

async function authorize(
  scope: Scope,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<AnalysisStoreScope | null> {
  if (
    (!local && !owner.workspaceId) ||
    (owner.appId && owner.appId !== scope.app_id) ||
    (owner.appIds && !owner.appIds.includes(scope.app_id))
  )
    return null;
  const environment = await repos.environments.getEnvironment(scope.environment_id);
  if (
    !environment ||
    environment.app_id !== scope.app_id ||
    !(await repos.apps.getApp(scope.app_id))
  )
    return null;
  return { ...scope, workspace: owner.workspaceId ?? 'local' };
}

function queryFrom(url: URL) {
  const input = Object.fromEntries(url.searchParams);
  return AnalysisQuery.safeParse({
    ...input,
    ...(input.filters ? { filters: JSON.parse(input.filters) } : {}),
  });
}

async function conversionReport(
  env: BrowserEnvironment,
  query: AnalysisQuery,
  scope: AnalysisStoreScope,
  local: boolean,
) {
  const store = local ? localStore : new D1AnalysisStore(env.DB!);
  const definitions = await store.list(scope);
  const to = Date.now();
  const durations = { '1h': 3600000, '24h': 86400000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
  const from = to - durations[query.range];
  const batches = local
    ? localConversionBatches()
    : await readConversionArchive(env, scope.workspace, query, from, to);
  return evaluateConversions({
    batches,
    query,
    definitions,
    from,
    to,
    source: local ? 'local' : 'archive',
    complete: local,
    coverage_note: local
      ? 'Local development events only. Restarting the server clears data.'
      : 'Observed archived events only. Recent queued/staged events may not be sealed; queue closure and full-period retention are unverified. Counts and rates are not a complete traffic census.',
  });
}

async function definitionRequest(
  request: Request,
  store: AnalysisStore,
  scope: AnalysisStoreScope,
  id?: string,
) {
  if (request.method === 'GET' && !id) return json(200, { records: await store.list(scope) });
  if (request.method === 'DELETE' && id) {
    const deleted = await store.remove(scope, id);
    return json(deleted ? 200 : 404, { deleted });
  }
  if (!((request.method === 'POST' && !id) || (request.method === 'PUT' && id)))
    return json(405, { error: 'method not allowed' });
  const definition = AnalysisDefinition.safeParse(await readPublicJson(request, 16384));
  if (!definition.success)
    return json(400, { error: 'Invalid goal, funnel or segment definition' });
  const record = await store.save(scope, definition.data, id);
  return record
    ? json(id ? 200 : 201, record)
    : json(404, { error: 'Analysis definition not found' });
}

async function analysisRequest(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
) {
  const url = new URL(request.url);
  const report = url.pathname === '/v1/analytics/conversions';
  const input = report
    ? queryFrom(url)
    : AnalysisScope.safeParse(Object.fromEntries(url.searchParams));
  if (!input.success) return json(400, { error: 'Invalid analysis query' });
  const scope = await authorize(input.data, owner, repos, local);
  if (!scope) return json(403, { error: 'Analysis project or environment scope forbidden' });
  if (report)
    return json(200, await conversionReport(env, AnalysisQuery.parse(input.data), scope, local));
  const store = local ? localStore : new D1AnalysisStore(env.DB!);
  return definitionRequest(request, store, scope, url.pathname.split('/')[4]);
}

function analysisError(error: unknown) {
  if (error instanceof SyntaxError) return json(400, { error: 'Invalid JSON' });
  if (error instanceof Error && error.message === 'payload too large')
    return json(413, { error: 'Analysis definition exceeds 16 KiB' });
  return json(503, {
    error:
      'Analysis unavailable. Reduce the period or retry after archive processing; no complete result is claimed.',
  });
}

export async function handleAnalysisOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  const report = url.pathname === '/v1/analytics/conversions';
  const match = /^\/v1\/analytics\/definitions(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
  if (!report && !match) return null;
  if (report && request.method !== 'GET') return json(405, { error: 'method not allowed' });
  if (!local && !env.DB) return json(503, { error: 'Analysis storage unavailable' });
  try {
    return await analysisRequest(request, env, owner, repos, local);
  } catch (error) {
    return analysisError(error);
  }
}
