import { apiScopeAllows } from './api-scope.js';
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
import { localProductEvents } from './product-event-local.js';
import { readProductArchive } from './product-event-archive.js';
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
    !apiScopeAllows(owner, scope) ||
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
  const budget = { objects: 0, bytes: 0 };
  const batches = local
    ? localConversionBatches()
    : await readConversionArchive(env, scope.workspace, query, from, to, budget);
  const products = local
    ? {
        facts: localProductEvents.read({ ...scope, workspace: scope.workspace }, from, to),
        pending: 0,
      }
    : env.DB && env.BROWSER_HISTORY?.get
      ? await readProductArchive(
          env.DB,
          {
            put: env.BROWSER_HISTORY.put.bind(env.BROWSER_HISTORY),
            get: env.BROWSER_HISTORY.get.bind(env.BROWSER_HISTORY),
          },
          scope,
          from,
          to,
          { objects: 200 - budget.objects, bytes: 8 * 1024 * 1024 - budget.bytes },
        )
      : { facts: [], pending: 0 };
  return evaluateConversions({
    batches,
    productFacts: products.facts,
    query,
    definitions,
    from,
    to,
    source: local ? 'local' : 'archive',
    complete: local,
    coverage_note: local
      ? 'Local development events only. Restarting the server clears data.'
      : `Observed archived browser and explicit product events only. ${products.pending} product batches are pending. Browser cohort rates exclude unlinked conversions. Queue closure and full-period retention are unverified; counts are not a complete traffic census.`,
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

type ConversionFailureReason =
  'work_limit' | 'deadline' | 'archive_integrity' | 'source_unavailable' | 'unknown';

type ConversionWorkLimit =
  | 'browser_shard_segments'
  | 'browser_window_segments'
  | 'combined_segments'
  | 'product_remaining_segments'
  | 'browser_events'
  | 'combined_events'
  | 'combined_bytes'
  | 'browser_compressed_bytes'
  | 'browser_decompressed_bytes'
  | 'revenue_capacity';
type ConversionFailure =
  | { reason: Exclude<ConversionFailureReason, 'work_limit'> }
  | { reason: 'work_limit'; limit: ConversionWorkLimit };

const conversionFailures = new Map<string, ConversionFailure>([
  [
    'Conversion scan limit exceeded; choose a shorter period.',
    { reason: 'work_limit', limit: 'browser_shard_segments' },
  ],
  [
    'Conversion segment limit exceeded.',
    { reason: 'work_limit', limit: 'browser_window_segments' },
  ],
  [
    'Combined conversion segment limit exceeded',
    { reason: 'work_limit', limit: 'combined_segments' },
  ],
  [
    'Combined conversion segment limit exceeded; choose a shorter period',
    { reason: 'work_limit', limit: 'product_remaining_segments' },
  ],
  [
    'Conversion event limit exceeded; choose a shorter period.',
    { reason: 'work_limit', limit: 'browser_events' },
  ],
  ['Combined conversion event limit exceeded', { reason: 'work_limit', limit: 'combined_events' }],
  ['Combined conversion byte limit exceeded', { reason: 'work_limit', limit: 'combined_bytes' }],
  ['global segment byte cap', { reason: 'work_limit', limit: 'browser_compressed_bytes' }],
  ['global decompressed cap', { reason: 'work_limit', limit: 'browser_decompressed_bytes' }],
  [
    'Tracked revenue exceeds exact report capacity',
    { reason: 'work_limit', limit: 'revenue_capacity' },
  ],
  ['Conversion scan time limit exceeded; choose a shorter period.', { reason: 'deadline' }],
  ['Product history time limit exceeded', { reason: 'deadline' }],
  ['Archive cursor did not advance', { reason: 'archive_integrity' }],
  ['missing segment', { reason: 'archive_integrity' }],
  ['missing manifest', { reason: 'archive_integrity' }],
  ['invalid manifest', { reason: 'archive_integrity' }],
  ['invalid archive gzip or UTF-8', { reason: 'archive_integrity' }],
  ['manifest mismatch', { reason: 'archive_integrity' }],
  ['checksum mismatch', { reason: 'archive_integrity' }],
  ['manifest length mismatch', { reason: 'archive_integrity' }],
  ['manifest row mismatch', { reason: 'archive_integrity' }],
  ['invalid archive batch', { reason: 'archive_integrity' }],
  ['manifest facts mismatch', { reason: 'archive_integrity' }],
  ['Product history checksum mismatch', { reason: 'archive_integrity' }],
  ['Product history manifest mismatch', { reason: 'archive_integrity' }],
  ['Product history object missing or changed', { reason: 'archive_integrity' }],
  ['Archive scope index unavailable', { reason: 'source_unavailable' }],
  ['Conversion archive unavailable', { reason: 'source_unavailable' }],
]);

function conversionFailure(error: unknown): ConversionFailure {
  if (!(error instanceof Error)) return { reason: 'unknown' };
  return conversionFailures.get(error.message) ?? { reason: 'unknown' };
}

function analysisError(error: unknown, report: boolean) {
  if (error instanceof Error && /[Aa]nalysis definition limit/.test(error.message))
    return json(409, {
      error:
        'This environment has reached its limit of 100 saved goals, funnels and segments. Delete an unused definition before creating another.',
    });
  if (error instanceof SyntaxError) return json(400, { error: 'Invalid JSON' });
  if (error instanceof Error && error.message === 'payload too large')
    return json(413, { error: 'Analysis definition exceeds 16 KiB' });
  return json(503, {
    error:
      'Analysis unavailable. Reduce the period or retry after archive processing; no complete result is claimed.',
    ...(report ? conversionFailure(error) : {}),
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
  if (!local && !env.DB)
    return json(503, {
      error: 'Analysis storage unavailable',
      ...(report ? { reason: 'source_unavailable' as const } : {}),
    });
  try {
    return await analysisRequest(request, env, owner, repos, local);
  } catch (error) {
    return analysisError(error, report);
  }
}
