import { browserMetadata } from './browser-metadata.js';
import { measureOwnerRouteRead, type OwnerRequestTimings } from './accounts.js';
import { readPublicJson } from './public-body.js';
import {
  BrowserReportFilter,
  BrowserBatchV1,
  PRESENCE_TTL_MS,
  type BrowserSummary,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
import {
  LocalBrowserAnalytics,
  browserSessionScope,
  queryBrowserSummary,
  type BrowserBindings,
  type CollectedBrowserBatch,
} from './browser-analytics.js';
import { queryBrowserReport } from './browser-reports.js';
import { telemetryScope } from './analytics-engine.js';
import {
  acceptBrowserVisitorBatch,
  confirmBrowserVisitorRolloutFullTraffic,
  deactivateBrowserVisitorScope,
  recordBrowserVisitorCoverageAudit,
  recordBrowserVisitorRolloutStart,
  recordBrowserVisitorScopeActivation,
  sealExactBrowserVisitorDay,
} from './browser-visitor-daily.js';
import {
  BROWSER_EVENT_FACTS_DIGEST_VERSION,
  digestBrowserEventFacts,
} from './browser-facts-digest.js';
import { cachedAnalytics } from './analytics-cache.js';
import type { SharedAnalytics } from '@app-health/contracts';
import {
  queryPublicBrowserBreakdowns,
  queryPublicBrowserTraffic,
} from './public-browser-report.js';
import {
  readBrowserArchiveAuditJob,
  startBrowserArchiveAuditJob,
} from './browser-archive-audit-jobs.js';

export interface BrowserEnvironment extends BrowserBindings {
  DB?: D1DatabaseLike;
  APP_HEALTH_INGEST_HOST?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_QUERY_TOKEN?: string;
}
const localAnalytics = new LocalBrowserAnalytics();
const UNSAFE_BROWSER_PATH = /[@?#\\\s]/;
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function cors(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  if (origin) response.headers.set('access-control-allow-origin', origin);
  response.headers.set('vary', 'Origin');
  return response;
}

function validBrowserEventTimes(events: BrowserBatchV1['events'], now: number): boolean {
  return !events.some(
    (event) => event.timestamp < now - 86_400_000 || event.timestamp > now + 60_000,
  );
}

function validBrowserEvents(input: BrowserBatchV1, now: number): boolean {
  if (
    input.attribution &&
    UNSAFE_BROWSER_PATH.test(decodeURIComponent(input.attribution.entry_path))
  )
    return false;
  return (
    validBrowserEventTimes(input.events, now) &&
    !input.events.some((event) => UNSAFE_BROWSER_PATH.test(decodeURIComponent(event.path)))
  );
}
async function browserContext(
  input: BrowserBatchV1,
  request: Request,
  app: string,
  environment: string,
) {
  const identity = input.visitor_id
    ? {
        visitor_hash: await browserSessionScope(app, environment, `visitor:${input.visitor_id}`),
        visit_type: input.visit_type,
      }
    : {};
  const attribution = input.attribution ?? {
    source: input.events[0]?.referrer ?? '',
    medium: '',
    campaign: '',
    content: '',
    term: '',
    entry_path: input.events[0]?.path ?? '/',
  };
  return {
    ...identity,
    attribution,
    metadata: browserMetadata(request, attribution),
  };
}

async function collectBrowser(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response> {
  const parsed = BrowserBatchV1.safeParse(await readPublicJson(request, 32_768));
  if (!parsed.success) return json(400, { error: 'invalid browser batch' });
  const input = parsed.data;
  const now = Date.now();
  if (!validBrowserEvents(input, now))
    return json(400, { error: 'invalid event timestamp or path' });
  const key = await repos.publicKeys?.verifyPublicKey(input.public_key);
  if (!key || !key.allowed_origins.includes(request.headers.get('origin') ?? ''))
    return json(403, { error: 'browser key or origin rejected' });
  const quota = await repos.publicKeys!.consumeBrowserQuota(
    `analytics:${key.id}`,
    Math.floor(now / 60_000) * 60_000,
    Math.max(1, input.events.length),
  );
  if (quota > 6000) return json(429, { error: 'browser quota exceeded' });
  const owned = local
    ? { workspace_id: 'local' }
    : await env.DB?.prepare('SELECT workspace_id FROM workspace_apps WHERE app_id = ?')
        .bind(key.app_id)
        .first<{ workspace_id: string }>();
  if (!owned) return json(409, { error: 'browser analytics requires an account-owned project' });
  const batch: CollectedBrowserBatch = {
    workspace: owned.workspace_id,
    app_id: key.app_id,
    environment_id: key.environment_id,
    batch_id: input.batch_id,
    received_at: now,
    events: input.events,
    ...(await browserContext(input, request, key.app_id, key.environment_id)),
  };
  return acceptBrowser(batch, input.session_id, env, repos, local);
}

export async function acceptBrowser(
  batch: CollectedBrowserBatch,
  session: string | undefined,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
) {
  const scopedBatch = session
    ? {
        ...batch,
        session_hash: await browserSessionScope(batch.app_id, batch.environment_id, session),
      }
    : batch;
  const durableBatch =
    !local && scopedBatch.events.length
      ? {
          ...scopedBatch,
          facts_digest_version:
            BROWSER_EVENT_FACTS_DIGEST_VERSION as typeof BROWSER_EVENT_FACTS_DIGEST_VERSION,
          facts_digest: await digestBrowserEventFacts(scopedBatch),
        }
      : scopedBatch;
  const activeSession =
    !batch.events.length ||
    batch.events.some((event) => event.timestamp > batch.received_at - PRESENCE_TTL_MS)
      ? session
      : undefined;
  let response: Response;
  if (local) {
    localAnalytics.ingest(durableBatch, activeSession);
    response = json(202, { accepted: batch.events.length, presence: !!activeSession });
  } else response = await enqueueBrowser(durableBatch, activeSession, env);
  if (response.status === 202 && durableBatch.events.length) {
    if (!local) {
      try {
        if (!env.DB) throw new Error('Browser visitor ledger unavailable');
        // Queue and presence work can outlast the initial request validation.
        // A 202 must never make an event older than the late window exact.
        const persistenceNow = Date.now();
        if (!validBrowserEventTimes(durableBatch.events, persistenceNow))
          throw new Error('Browser event timestamp expired before durable acceptance');
        await acceptBrowserVisitorBatch(env.DB, durableBatch, persistenceNow);
      } catch {
        // Queue.send alone does not qualify as a 202: exact acceptance must also
        // commit before returning success. The queue may contain this failed
        // attempt; it is not represented in the exact ledger here.
        return json(503, { error: 'browser analytics persistence unavailable' });
      }
    }
    try {
      await repos.capabilities?.recordCapability(
        durableBatch.app_id,
        durableBatch.environment_id,
        'analytics',
        durableBatch.received_at,
      );
    } catch {
      // Capability inventory is auxiliary. Once Queue and the exact ledger
      // commit, an inventory outage must not turn accepted telemetry into 503.
      console.warn(JSON.stringify({ event: 'browser_capability_record_failed' }));
    }
  }
  return response;
}

async function enqueueBrowser(
  batch: CollectedBrowserBatch,
  session: string | undefined,
  env: BrowserEnvironment,
): Promise<Response> {
  if (
    !env.BROWSER_EVENTS ||
    !env.WORKSPACE_PRESENCE ||
    !env.BROWSER_HISTORY ||
    !env.BROWSER_ARCHIVE ||
    !env.BROWSER_ANALYTICS
  )
    return json(503, { error: 'browser analytics not configured' });
  if (batch.events.length) await env.BROWSER_EVENTS.send(batch);
  if (!session) return json(202, { accepted: batch.events.length, presence: false });
  try {
    await env.WORKSPACE_PRESENCE.getByName(batch.workspace).heartbeat(
      batch.app_id,
      batch.environment_id,
      await telemetryScope(batch.app_id, session),
    );
  } catch {
    return json(batch.events.length ? 202 : 503, {
      accepted: batch.events.length,
      presence: false,
    });
  }
  return json(202, { accepted: batch.events.length, presence: true });
}

export async function handleBrowserIngest(
  request: Request,
  env: BrowserEnvironment,
  repos: AppHealthRepositories,
  local: boolean,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/browser') return null;
  if (!local && url.hostname !== env.APP_HEALTH_INGEST_HOST)
    return json(404, { error: 'not found' });
  if (request.method === 'OPTIONS')
    return cors(
      request,
      new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      }),
    );
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  try {
    return cors(request, await collectBrowser(request, env, repos, local));
  } catch (error) {
    const status =
      error instanceof SyntaxError || error instanceof URIError
        ? 400
        : error instanceof Error && error.message === 'payload too large'
          ? 413
          : 503;
    return cors(
      request,
      json(status, {
        error:
          status === 503 ? 'collector unavailable; retry this batch' : 'invalid browser payload',
      }),
    );
  }
}

const BROWSER_AUDIT_PATH = '/v1/browser/archive-audits';
const BROWSER_VISITOR_COVERAGE_PATH = '/v1/browser/visitor-coverage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

type CoverageActionArgs = {
  db: D1DatabaseLike;
  workspace: string;
  input: Record<string, unknown>;
  now: number;
};

function validCoverageTimestamps(input: Record<string, unknown>, now: number): boolean {
  return Object.entries(input).every(
    ([key, value]) =>
      (!key.endsWith('_at') && key !== 'audited_through') ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value <= now + 60_000),
  );
}

async function ownedProductionScope(
  db: D1DatabaseLike,
  workspace: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  if (input.app_id === undefined && input.environment_id === undefined) return true;
  if (typeof input.app_id !== 'string' || typeof input.environment_id !== 'string') return false;
  const scope = await db
    .prepare(
      `SELECT 1 AS owned FROM environments e JOIN workspace_apps wa
       ON wa.app_id = e.app_id AND wa.workspace_id = ?
       WHERE e.id = ? AND e.app_id = ? AND lower(e.name) = 'production' LIMIT 1`,
    )
    .bind(workspace, input.environment_id, input.app_id)
    .first<{ owned: number }>();
  return scope !== null;
}

async function rolloutStartAction({ db, workspace, input }: CoverageActionArgs) {
  if (
    !exactKeys(input, [
      'action',
      'generation_id',
      'worker_version_id',
      'source_sha',
      'rollout_started_at',
      'rollout_observed_at',
      'rollout_traffic_percent',
    ])
  )
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  await recordBrowserVisitorRolloutStart(db, { ...input, workspace_id: workspace } as never);
  return json(201, { recorded: true });
}

async function rolloutFullAction({ db, workspace, input }: CoverageActionArgs) {
  if (
    !exactKeys(input, [
      'action',
      'generation_id',
      'worker_version_id',
      'source_sha',
      'full_traffic_at',
      'observed_at',
      'traffic_percent',
    ])
  )
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  await confirmBrowserVisitorRolloutFullTraffic(db, { ...input, workspace_id: workspace } as never);
  return json(200, { recorded: true });
}

async function trackerActivateAction({ db, workspace, input }: CoverageActionArgs) {
  if (
    !exactKeys(input, [
      'action',
      'app_id',
      'environment_id',
      'activated_at',
      'verified_at',
      'tracker_source_sha',
    ])
  )
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  await recordBrowserVisitorScopeActivation(db, { ...input, workspace_id: workspace } as never);
  return json(201, { recorded: true });
}

async function trackerDeactivateAction({ db, workspace, input }: CoverageActionArgs) {
  if (
    !exactKeys(input, [
      'action',
      'app_id',
      'environment_id',
      'activated_at',
      'tracker_source_sha',
      'deactivated_at',
    ])
  )
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  await deactivateBrowserVisitorScope(db, { ...input, workspace_id: workspace } as never);
  return json(200, { recorded: true });
}

async function coverageAuditAction({ db, workspace, input }: CoverageActionArgs) {
  const globalAudit = input.audit_kind === 'worker_rollouts';
  const scopeAudit = input.audit_kind === 'tracker_scope';
  const keys = [
    'action',
    'audit_id',
    'audit_kind',
    ...(globalAudit ? [] : ['app_id', 'environment_id']),
    'audited_through',
    'observed_at',
    'evidence_sha',
  ];
  if ((!globalAudit && !scopeAudit) || !exactKeys(input, keys))
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  await recordBrowserVisitorCoverageAudit(db, { ...input, workspace_id: workspace } as never);
  return json(201, { recorded: true });
}

async function sealCoverageDayAction({ db, workspace, input, now }: CoverageActionArgs) {
  if (
    !exactKeys(input, ['action', 'app_id', 'environment_id', 'day']) ||
    typeof input.app_id !== 'string' ||
    typeof input.environment_id !== 'string' ||
    typeof input.day !== 'string'
  )
    return json(400, { error: 'Invalid coverage proof action or fields.' });
  const sealed = await sealExactBrowserVisitorDay(db, {
    workspace_id: workspace,
    app_id: input.app_id,
    environment_id: input.environment_id,
    day: input.day,
    now,
  });
  return sealed
    ? json(200, { sealed: true })
    : json(409, { error: 'Coverage proof is incomplete or the day is already sealed.' });
}

async function handleBrowserVisitorCoverageOperator(
  request: Request,
  env: BrowserEnvironment,
  workspace: string,
): Promise<Response> {
  let input: unknown;
  try {
    input = await readPublicJson(request, 4096);
  } catch {
    return json(400, { error: 'Invalid coverage proof request.' });
  }
  if (!isRecord(input) || typeof input.action !== 'string')
    return json(400, { error: 'Invalid coverage proof request.' });
  const now = Date.now();
  if (!validCoverageTimestamps(input, now))
    return json(400, { error: 'Coverage proof timestamps must be finite and provider-observed.' });
  if (!(await ownedProductionScope(env.DB!, workspace, input)))
    return json(404, { error: 'Production scope not found.' });
  const handlers: Record<string, (args: CoverageActionArgs) => Promise<Response>> = {
    'rollout-start': rolloutStartAction,
    'rollout-full': rolloutFullAction,
    'tracker-activate': trackerActivateAction,
    'tracker-deactivate': trackerDeactivateAction,
    audit: coverageAuditAction,
    'seal-day': sealCoverageDayAction,
  };
  const handler = handlers[input.action];
  if (!handler) return json(400, { error: 'Invalid coverage proof action or fields.' });
  try {
    return await handler({ db: env.DB!, workspace, input, now });
  } catch {
    return json(409, { error: 'Coverage proof was rejected or could not be recorded.' });
  }
}

function isBrowserAuditPath(path: string) {
  return path === BROWSER_AUDIT_PATH || path.startsWith(`${BROWSER_AUDIT_PATH}/`);
}

function browserAuditOwnerAllowed(owner: OwnerIdentity, local: boolean) {
  return !local && Boolean(owner.workspaceId) && !owner.appId;
}

async function startBrowserAuditRoute(
  request: Request,
  env: BrowserEnvironment,
  workspace: string,
) {
  const url = new URL(request.url);
  const queryKeys = [...url.searchParams.keys()];
  if (queryKeys.some((key) => key !== 'day') || url.searchParams.getAll('day').length !== 1)
    return json(400, { error: 'Provide one valid day.' });
  const archiveProbe = env.BROWSER_ARCHIVE?.getByName(`${workspace}:browser-archive-v1:0`);
  if (
    !archiveProbe?.archiveSegmentsForEventDay ||
    !archiveProbe.archiveSegmentForBatch ||
    !env.BROWSER_HISTORY?.get
  )
    return json(503, { error: 'Archive audit bindings are unavailable.' });
  try {
    return json(
      202,
      await startBrowserArchiveAuditJob(env.DB!, workspace, url.searchParams.get('day') ?? ''),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'audit already running')
      return json(409, { error: 'An archive audit is already running.' });
    if (message === 'audit job quota')
      return json(429, { error: 'Archive audit request limit reached.' });
    if (message === 'audit receipt cap')
      return json(413, { error: 'The selected day exceeds the audit work limit.' });
    if (message === 'invalid scope') return json(400, { error: 'Provide one valid day.' });
    return json(503, { error: 'Archive audit could not be started.' });
  }
}

async function readBrowserAuditStatusRoute(
  request: Request,
  env: BrowserEnvironment,
  workspace: string,
  path: string,
) {
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length)
    return json(400, { error: 'Invalid audit status query.' });
  const jobId = path.slice(`${BROWSER_AUDIT_PATH}/`.length);
  if (!jobId || jobId.includes('/')) return json(404, { error: 'Archive audit not found.' });
  try {
    const result = await readBrowserArchiveAuditJob(env.DB!, workspace, jobId);
    return result ? json(200, result) : json(404, { error: 'Archive audit not found.' });
  } catch {
    return json(503, { error: 'Archive audit status is unavailable.' });
  }
}

async function handleBrowserArchiveAuditOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
  path: string,
): Promise<Response | null> {
  if (!isBrowserAuditPath(path)) return null;
  if (!browserAuditOwnerAllowed(owner, local))
    return json(403, { error: 'Full workspace owner access is required.' });
  if (!env.DB) return json(503, { error: 'Archive audit storage is unavailable.' });
  if (path === BROWSER_AUDIT_PATH && request.method === 'POST')
    return startBrowserAuditRoute(request, env, owner.workspaceId!);
  if (path.startsWith(`${BROWSER_AUDIT_PATH}/`) && request.method === 'GET')
    return readBrowserAuditStatusRoute(request, env, owner.workspaceId!, path);
  return json(405, { error: 'Method not allowed.' });
}

type BrowserPresence = ReturnType<NonNullable<BrowserBindings['WORKSPACE_PRESENCE']>['getByName']>;

function browserWorkspace(owner: OwnerIdentity, local: boolean) {
  return local ? 'local' : owner.workspaceId;
}

async function browserVisitorCoverageOwnerRoute(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== BROWSER_VISITOR_COVERAGE_PATH) return null;
  if (!browserAuditOwnerAllowed(owner, local))
    return json(403, { error: 'Full workspace owner access is required.' });
  if (!env.DB) return json(503, { error: 'Coverage proof storage is unavailable.' });
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json(403, { error: 'Same-origin operator request required.' });
  return handleBrowserVisitorCoverageOperator(request, env, owner.workspaceId!);
}

async function browserLiveRoute(request: Request, presence: BrowserPresence) {
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json(403, { error: 'same-origin stream required' });
  return presence.fetch(
    new Request('https://presence/live', {
      headers: { upgrade: request.headers.get('upgrade') ?? '' },
    }),
  );
}

export async function handleBrowserOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
  timings?: OwnerRequestTimings,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const coverageResponse = await browserVisitorCoverageOwnerRoute(request, env, owner, local);
  if (coverageResponse) return coverageResponse;
  const auditResponse = await handleBrowserArchiveAuditOwner(request, env, owner, local, path);
  if (auditResponse) return auditResponse;
  if (!['/v1/analytics', '/v1/analytics/live', '/v1/analytics/report'].includes(path)) return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const workspace = browserWorkspace(owner, local);
  if (!workspace) return json(403, { error: 'Sign in with Google to view workspace analytics.' });
  if (path === '/v1/analytics/report')
    return measureOwnerRouteRead(timings, () => browserReport(request, env, owner, local, timings));
  if (local) return json(200, localAnalytics.summary());
  if (!env.WORKSPACE_PRESENCE || !env.BROWSER_EVENTS)
    return json(503, { error: 'Browser analytics is not configured yet.' });
  const presence = env.WORKSPACE_PRESENCE.getByName(workspace);
  if (path.endsWith('/live')) return browserLiveRoute(request, presence);
  return workspaceSummary(workspace, env, presence, owner.appIds ?? []);
}

async function workspaceSummary(
  workspace: string,
  env: BrowserEnvironment,
  presence: BrowserPresence,
  appIds: readonly string[],
): Promise<Response> {
  try {
    const [metrics, live] = await Promise.all([
      cachedAnalytics(env.CLOUDFLARE_ACCOUNT_ID ?? '', workspace, 'summary', () =>
        queryBrowserSummary(workspace, {
          accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
          token: env.ANALYTICS_ENGINE_QUERY_TOKEN ?? '',
        }),
      ),
      presence.snapshot(),
    ]);
    const active = new Set(appIds);
    const liveProjects = live.projects.filter((project) => active.has(project.app_id));
    const body: BrowserSummary = {
      ...metrics,
      enabled: true,
      source: 'analytics-engine',
      projects: metrics.projects.filter((project) => active.has(project.app_id)),
      live: {
        ...live,
        projects: liveProjects,
        total: liveProjects.reduce((sum, project) => sum + project.active, 0),
      },
      stream: true,
    };
    return json(200, body);
  } catch {
    return json(503, { error: 'Browser analytics is temporarily unavailable.' });
  }
}

async function browserReport(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
  timings?: OwnerRequestTimings,
): Promise<Response> {
  const filter = BrowserReportFilter.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!filter.success) return json(400, { error: 'Invalid analytics filter.' });
  if (!local && filter.data.app_id && !owner.appIds?.includes(filter.data.app_id))
    return json(403, { error: 'Project access denied.' });
  if (local) return json(200, localAnalytics.report(filter.data));
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.ANALYTICS_ENGINE_QUERY_TOKEN;
  if (!env.BROWSER_ANALYTICS || !accountId || !token)
    return json(503, { error: 'Web analytics is not configured yet.' });
  try {
    return json(
      200,
      await cachedAnalytics(
        accountId,
        owner.workspaceId!,
        JSON.stringify([filter.data, owner.appIds ?? []]),
        () =>
          queryBrowserReport(owner.workspaceId!, filter.data, {
            accountId,
            token,
            appIds: owner.appIds ?? [],
            timings,
          }),
        undefined,
        60,
        timings,
      ),
    );
  } catch {
    return json(503, { error: 'Event reports are temporarily unavailable.' });
  }
}

/** Called only after a current, unrevoked share has resolved its immutable scope. */
export async function sharedBrowserMetrics(
  scope: { workspace: string; app_id: string; environment_id: string },
  env: BrowserEnvironment,
  local: boolean,
  includeBreakdowns = false,
): Promise<Omit<SharedAnalytics, 'project'>> {
  const emptyLive = { active: null, measured_at: Date.now(), ttl_ms: 45000 } as const;
  if (local) {
    const report = localAnalytics.report({
      range: '24h',
      app_id: scope.app_id,
      environment_id: scope.environment_id,
    });
    const live = localAnalytics.snapshot();
    const active =
      live.projects.find(
        (row) => row.app_id === scope.app_id && row.environment_id === scope.environment_id,
      )?.active ?? 0;
    const series = report.series.map(({ timestamp, pageviews }) => ({ timestamp, pageviews }));
    return {
      source: 'local',
      sampled: false,
      updated_at: Date.now(),
      live: { ...emptyLive, active, measured_at: live.measured_at },
      traffic: {
        from: report.from,
        to: report.to,
        series,
        pageviews: series.reduce((sum, row) => sum + row.pageviews, 0),
      },
      ...(includeBreakdowns
        ? {
            breakdowns: {
              sessions: report.sessions,
              events: report.series.reduce((sum, row) => sum + row.events, 0),
              pages: report.pages,
              sources: report.sources,
              countries: report.audience?.countries ?? [],
            },
          }
        : {}),
    };
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const key = JSON.stringify([scope.app_id, scope.environment_id]);
  const reportPromise = includeBreakdowns
    ? cachedAnalytics(accountId, scope.workspace, `shared-report:${key}`, () =>
        queryPublicBrowserBreakdowns(scope.workspace, scope.app_id, scope.environment_id, {
          accountId,
          token: env.ANALYTICS_ENGINE_QUERY_TOKEN ?? '',
        }),
      ).catch(() => null)
    : Promise.resolve(null);
  const [live, report] = await Promise.all([
    cachedAnalytics(
      accountId,
      scope.workspace,
      `shared-live:${key}`,
      async () => {
        const stub = env.WORKSPACE_PRESENCE?.getByName(scope.workspace);
        if (!stub?.publicSnapshot) throw new Error('Presence unavailable');
        return stub.publicSnapshot(scope.app_id, scope.environment_id);
      },
      undefined,
      10,
    ).catch(() => emptyLive),
    reportPromise,
  ]);
  const history = report
    ? { traffic: report.traffic, sampled: report.sampled }
    : await cachedAnalytics(accountId, scope.workspace, `shared-traffic:${key}`, () =>
        queryPublicBrowserTraffic(scope.workspace, scope.app_id, scope.environment_id, {
          accountId,
          token: env.ANALYTICS_ENGINE_QUERY_TOKEN ?? '',
        }),
      ).catch(() => null);
  const traffic = history?.traffic;
  return {
    source: 'analytics-engine',
    sampled: report?.sampled ?? history?.sampled ?? false,
    updated_at: Date.now(),
    live,
    traffic: traffic ?? null,
    ...(report ? { breakdowns: report.breakdowns } : {}),
  };
}
