import { readPublicJson } from './public-body.js';
import { BrowserReportFilter, BrowserBatchV1, type BrowserSummary } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import type { AppHealthRepositories } from './repository.js';
import {
  LocalBrowserAnalytics,
  queryBrowserSummary,
  type BrowserBindings,
  type CollectedBrowserBatch,
} from './browser-analytics.js';
import { queryBrowserReport } from './browser-reports.js';
import { telemetryScope } from './analytics-engine.js';
import { cachedAnalytics } from './analytics-cache.js';
import type { SharedAnalytics } from '@app-health/contracts';
import { queryPublicBrowserTraffic } from './public-browser-report.js';

export interface BrowserEnvironment extends BrowserBindings {
  DB?: D1DatabaseLike;
  APP_HEALTH_INGEST_HOST?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_QUERY_TOKEN?: string;
}
const localAnalytics = new LocalBrowserAnalytics();
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function cors(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  if (origin) response.headers.set('access-control-allow-origin', origin);
  response.headers.set('vary', 'Origin');
  return response;
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
  if (
    input.events.some(
      (event) =>
        event.timestamp < now - 86_400_000 ||
        event.timestamp > now + 60_000 ||
        /[@?#\\\s]/.test(decodeURIComponent(event.path)),
    )
  )
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
  let response: Response;
  if (local) {
    localAnalytics.ingest(batch, session);
    response = json(202, { accepted: batch.events.length, presence: true });
  } else response = await enqueueBrowser(batch, session, env);
  if (response.status === 202 && batch.events.length) {
    await repos.capabilities?.recordCapability(
      batch.app_id,
      batch.environment_id,
      'analytics',
      batch.received_at,
    );
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

export async function handleBrowserOwner(
  request: Request,
  env: BrowserEnvironment,
  owner: OwnerIdentity,
  local: boolean,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!['/v1/analytics', '/v1/analytics/live', '/v1/analytics/report'].includes(path)) return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const workspace = local ? 'local' : owner.workspaceId;
  if (!workspace) return json(403, { error: 'Sign in with Google to view workspace analytics.' });
  if (path === '/v1/analytics/report') return browserReport(request, env, owner, local);
  if (local) return json(200, localAnalytics.summary());
  if (!env.WORKSPACE_PRESENCE || !env.BROWSER_EVENTS)
    return json(503, { error: 'Browser analytics is not configured yet.' });
  const presence = env.WORKSPACE_PRESENCE.getByName(workspace);
  if (path.endsWith('/live')) {
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json(403, { error: 'same-origin stream required' });
    return presence.fetch(
      new Request('https://presence/live', {
        headers: { upgrade: request.headers.get('upgrade') ?? '' },
      }),
    );
  }
  return workspaceSummary(workspace, env, presence);
}

async function workspaceSummary(
  workspace: string,
  env: BrowserEnvironment,
  presence: ReturnType<NonNullable<BrowserBindings['WORKSPACE_PRESENCE']>['getByName']>,
): Promise<Response> {
  try {
    const metrics = await cachedAnalytics(
      env.CLOUDFLARE_ACCOUNT_ID ?? '',
      workspace,
      'summary',
      () =>
        queryBrowserSummary(workspace, {
          accountId: env.CLOUDFLARE_ACCOUNT_ID ?? '',
          token: env.ANALYTICS_ENGINE_QUERY_TOKEN ?? '',
        }),
    );
    const body: BrowserSummary = {
      ...metrics,
      enabled: true,
      source: 'analytics-engine',
      live: await presence.snapshot(),
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
      await cachedAnalytics(accountId, owner.workspaceId!, JSON.stringify(filter.data), () =>
        queryBrowserReport(owner.workspaceId!, filter.data, {
          accountId,
          token,
        }),
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
    };
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const key = JSON.stringify([scope.app_id, scope.environment_id]);
  const [live, history] = await Promise.all([
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
    cachedAnalytics(accountId, scope.workspace, `shared-traffic:${key}`, () =>
      queryPublicBrowserTraffic(scope.workspace, scope.app_id, scope.environment_id, {
        accountId,
        token: env.ANALYTICS_ENGINE_QUERY_TOKEN ?? '',
      }),
    ).catch(() => null),
  ]);
  return {
    source: 'analytics-engine',
    sampled: history?.sampled ?? false,
    updated_at: Date.now(),
    live,
    traffic: history?.traffic ?? null,
  };
}
