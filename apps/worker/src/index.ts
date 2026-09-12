import { cleanupExpiredAccountRecords } from './account-retention.js';
import {
  selfAnalyticsConfig,
  scheduleProductMilestone,
  type SelfAnalyticsBindings,
} from './self-analytics.js';
import { handleAnalyticsShareOwner, handlePublicAnalytics } from './analytics-share-routes.js';
import { handleNativeIngest, handleNativeKeyOwner } from './native-routes.js';
import { handleProjectRoutes } from './project-routes.js';
import { EndpointCapacityError } from './endpoint-capacity.js';
import { legacyLogAlertsAllowed } from './log-alert-scope.js';
import {
  handleBrowserIngest,
  handleBrowserOwner,
  type BrowserEnvironment,
} from './browser-routes.js';
import {
  CreateAppRequestV1,
  DEFAULT_FAILURE_QUERY_LIMIT,
  EndpointQueryRequestV1,
  FailureQueryRequestV1,
  InstallationStatusV1,
  ListAppsResponseV1,
  CreatePublicLogKeyRequestV1,
  LOG_RETENTION_DAYS,
  ListPublicLogKeysResponseV1,
  LogQueryRequestV1,
  WINDOWS,
  type Window,
} from '@app-health/contracts';
import {
  AnalyticsEngineBuckets,
  createAnalyticsQuery,
  type AnalyticsEngineDatasetLike,
} from './analytics-engine.js';
import { D1ControlPlane, type D1DatabaseLike } from './d1-adapter.js';
import { InMemoryAdapter, DEDUPE_WINDOW_MS } from './in-memory-adapter.js';
import type { AppHealthRepositories } from './repository.js';
import {
  BearerOwnerIdentityAdapter,
  LocalOwnerIdentityAdapter,
  type OwnerIdentityAdapter,
  type OwnerIdentity,
} from './identity.js';
import { AppHealthService, type LogIngestResult } from './service.js';
import { deliverSinks, resolveLogRoutes } from './log-routing.js';
import { InvalidOtlpError, otlpSuccessBody, projectOtlpTraces } from './otlp.js';
import { handleAgentEdge } from './agent-edge.mjs';

import {
  accountsConfigured,
  accountIdentity,
  accountMutationAllowed,
  createAccountAuth,
  type AccountBindings,
} from './accounts.js';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_OTLP_BODY_BYTES = 1024 * 1024;

export interface Env extends AccountBindings, BrowserEnvironment, SelfAnalyticsBindings {
  APP_HEALTH_MODE?: string;
  APP_HEALTH_DASHBOARD_HOST?: string;
  APP_HEALTH_INGEST_HOST?: string;
  APP_HEALTH_INGEST_ORIGIN?: string;
  OWNER_AUTH_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_QUERY_TOKEN?: string;
  /** Optional Slack incoming-webhook URL for application log alerts. */
  LOG_ALERT_WEBHOOK_URL?: string;
  /** Server-log alert threshold used by the default routes: debug | info | warn | error. Default info. */
  LOG_ALERT_MIN_LEVEL?: string;
  /** Optional JSON LogRoutesV1 overriding the default routing of logs to sinks. */
  LOG_ROUTES?: string;
  DB?: D1DatabaseLike;
  TELEMETRY?: AnalyticsEngineDatasetLike;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

function json(status: number, body: unknown, noStore = false): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (noStore) headers['cache-control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

interface AdapterBundle {
  repos: AppHealthRepositories;
  service: AppHealthService;
  identity: OwnerIdentityAdapter;
  local: boolean;
}

let cachedLocalAdapter: Promise<AdapterBundle> | null = null;

async function resolveAdapter(env: Env): Promise<AdapterBundle | null> {
  if (env.APP_HEALTH_MODE === 'local') {
    if (!cachedLocalAdapter) {
      cachedLocalAdapter = InMemoryAdapter.create()
        .then((adapter) => {
          const repos = adapter.asRepositories();
          return {
            repos,
            service: new AppHealthService(repos),
            identity: new LocalOwnerIdentityAdapter(),
            local: true,
          };
        })
        .catch((error) => {
          cachedLocalAdapter = null;
          throw error;
        });
    }
    return cachedLocalAdapter;
  }
  if (
    !env.DB ||
    !env.TELEMETRY ||
    !env.OWNER_AUTH_TOKEN ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.ANALYTICS_ENGINE_QUERY_TOKEN ||
    !env.APP_HEALTH_DASHBOARD_HOST ||
    !env.APP_HEALTH_INGEST_HOST ||
    !env.APP_HEALTH_INGEST_ORIGIN
  )
    return null;
  const buckets = new AnalyticsEngineBuckets(
    env.TELEMETRY,
    createAnalyticsQuery({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      token: env.ANALYTICS_ENGINE_QUERY_TOKEN,
    }),
  );
  const control = new D1ControlPlane(env.DB);
  const repos = control.asRepositories(buckets);
  return {
    repos,
    service: new AppHealthService(repos),
    identity: new BearerOwnerIdentityAdapter(env.OWNER_AUTH_TOKEN, repos.keys),
    local: false,
  };
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

function extractBearerKey(request: Request): string {
  return request.headers.get('authorization')?.match(BEARER_PATTERN)?.[1]?.trim() ?? '';
}

function ownerCanAccessApp(owner: OwnerIdentity, appId: string): boolean {
  return owner.appIds
    ? owner.appIds.includes(appId)
    : owner.appId === undefined || owner.appId === appId;
}

function productScopeForbidden(): Response {
  return json(403, { error: 'product scope forbids this operation' }, true);
}

async function readJsonBounded(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) throw new BodyTooLargeError();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function readStreamBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readOtlpBodyBounded(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_OTLP_BODY_BYTES) throw new BodyTooLargeError();
  const encoded = await readStreamBounded(request.body, MAX_OTLP_BODY_BYTES);
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return encoded;
  if (encoding !== 'gzip') throw new UnsupportedEncodingError();
  try {
    const decompressed = new Blob([encoded])
      .stream()
      .pipeThrough(new DecompressionStream('gzip')) as ReadableStream<Uint8Array>;
    return await readStreamBounded(decompressed, MAX_OTLP_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    throw new InvalidOtlpError('invalid gzip-compressed OTLP body');
  }
}

function otlpContentType(request: Request): 'protobuf' | 'json' | null {
  const value = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (value === 'application/x-protobuf' || value === 'application/protobuf') return 'protobuf';
  if (value === 'application/json') return 'json';
  return null;
}

class BodyTooLargeError extends Error {}

/** The subset of ExecutionContext the worker uses. Optional so tests and the Vite dev bridge can omit it. */
interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void;
}
class UnsupportedEncodingError extends Error {}

function hostAllowed(url: URL, bundle: AdapterBundle, env: Env, kind: 'owner' | 'ingest'): boolean {
  if (bundle.local) return true;
  if (url.hostname.endsWith('.workers.dev')) return false;
  return (
    url.hostname === (kind === 'owner' ? env.APP_HEALTH_DASHBOARD_HOST : env.APP_HEALTH_INGEST_HOST)
  );
}

async function handleIngestRoute(
  request: Request,
  bundle: AdapterBundle,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/ingest') return null;
  if (!hostAllowed(url, bundle, env, 'ingest')) return json(404, { error: 'not found' });
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  try {
    const result = await bundle.service.ingest(
      extractBearerKey(request),
      await readJsonBounded(request),
      Date.now(),
    );
    if (!result.ok) return json(result.status, { error: result.error });
    return json(202, { accepted: result.accepted, duplicates: result.duplicates });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json(413, { error: 'request body too large' });
    if (error instanceof EndpointCapacityError) return json(413, { error: error.message });
    throw error;
  }
}

async function handleTracesRoute(
  request: Request,
  bundle: AdapterBundle,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/traces') return null;
  if (!hostAllowed(url, bundle, env, 'ingest')) return json(404, { error: 'not found' });
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  const contentType = otlpContentType(request);
  if (!contentType) return json(415, { error: 'unsupported OTLP content type' });
  const keyRecord = await bundle.service.verifyIngestKey(extractBearerKey(request));
  if (!keyRecord) return json(401, { error: 'invalid or revoked ingest key' });
  try {
    const projection = await projectOtlpTraces(await readOtlpBodyBounded(request), contentType);
    const result = await bundle.service.ingestEvents(
      keyRecord,
      'otel',
      undefined,
      projection.events,
      Date.now(),
    );
    if (!result.ok) return json(result.status, { error: result.error });
    const responseType = contentType === 'protobuf' ? 'application/x-protobuf' : 'application/json';
    return new Response(otlpSuccessBody(contentType, projection.rejectedSpans), {
      status: 200,
      headers: { 'content-type': responseType },
    });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json(413, { error: 'request body too large' });
    if (error instanceof UnsupportedEncodingError)
      return json(415, { error: 'unsupported content encoding' });
    if (error instanceof EndpointCapacityError) return json(413, { error: error.message });
    if (error instanceof InvalidOtlpError) return json(400, { error: error.message });
    throw error;
  }
}

async function deliverRoutedSinks(
  result: LogIngestResult & { ok: true },
  bundle: AdapterBundle,
  env: Env,
): Promise<void> {
  if (!env.LOG_ALERT_WEBHOOK_URL || !(await legacyLogAlertsAllowed(env.DB, result.app_id))) return;
  const external = Object.keys(result.sinks).filter((sink) => sink !== 'store');
  if (external.length === 0) return;
  const [app, environment] = await Promise.all([
    bundle.repos.apps.getApp(result.app_id),
    bundle.repos.environments.getEnvironment(result.environment_id),
  ]);
  await deliverSinks(
    result.sinks,
    {
      appName: app?.name ?? result.app_id,
      environmentName: environment?.name ?? result.environment_id,
    },
    env,
  );
}

/** Browser responses echo the caller's origin so the page can read the status. */
function corsFor(request: Request, response: Response): Response {
  const origin = request.headers.get('origin');
  if (origin) {
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('vary', 'origin');
  }
  return response;
}

function isBrowserBatch(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { public_key?: unknown }).public_key === 'string'
  );
}

async function handleLogsIngestRoute(
  request: Request,
  bundle: AdapterBundle,
  env: Env,
  url: URL,
  ctx: WorkerContext | undefined,
): Promise<Response | null> {
  if (url.pathname !== '/v1/logs' || !['POST', 'OPTIONS'].includes(request.method)) return null;
  if (!hostAllowed(url, bundle, env, 'ingest')) return json(404, { error: 'not found' });
  if (request.method === 'OPTIONS') return corsFor(request, preflightResponse());
  try {
    const body = await readJsonBounded(request);
    const routes = resolveLogRoutes(env);
    const result = isBrowserBatch(body)
      ? await bundle.service.ingestBrowserLogs(
          body,
          request.headers.get('origin'),
          Date.now(),
          routes,
        )
      : await bundle.service.ingestLogs(extractBearerKey(request), body, Date.now(), routes);
    if (!result.ok) {
      return corsFor(
        request,
        json(result.status, { error: result.error, details: result.details }),
      );
    }
    const delivery = deliverRoutedSinks(result, bundle, env);
    if (ctx) ctx.waitUntil(delivery);
    else await delivery;
    return corsFor(
      request,
      json(202, {
        accepted: result.accepted,
        duplicates: result.duplicates,
        source: result.source,
      }),
    );
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json(413, { error: 'request body too large' });
    throw error;
  }
}

function preflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

const PUBLIC_KEY_REVOKE_PATTERN = /^\/v1\/public-keys\/([^/]+)\/revoke$/;

async function handlePublicKeyRevoke(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  keyId: string,
): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (owner.appId || owner.appIds) {
    const key = await bundle.repos.publicKeys?.getPublicKey(keyId);
    if (!key || !ownerCanAccessApp(owner, key.app_id)) return productScopeForbidden();
  }
  const revoked = await bundle.service.revokePublicKey(keyId, Date.now());
  return revoked
    ? json(200, { revoked: true, key_id: keyId }, true)
    : json(404, { error: 'no active public key' }, true);
}

async function handlePublicKeysRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  const revokeMatch = url.pathname.match(PUBLIC_KEY_REVOKE_PATTERN);
  if (revokeMatch) return handlePublicKeyRevoke(request, bundle, owner, revokeMatch[1]);
  if (url.pathname !== '/v1/public-keys') return null;
  if (request.method === 'GET') {
    const appId = url.searchParams.get('app_id');
    if (!appId) return json(400, { error: 'app_id is required' }, true);
    if (!ownerCanAccessApp(owner, appId)) return productScopeForbidden();
    const keys = await bundle.service.listPublicKeys(appId);
    return json(200, ListPublicLogKeysResponseV1.parse({ keys }), true);
  }
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  try {
    const parsed = CreatePublicLogKeyRequestV1.safeParse(await readJsonBounded(request));
    if (!parsed.success) return json(400, { error: 'invalid public key request' }, true);
    if (!ownerCanAccessApp(owner, parsed.data.app_id)) return productScopeForbidden();
    const created = await bundle.service.createPublicKey(parsed.data, Date.now());
    if (!created) return json(404, { error: 'environment not found for app' }, true);
    return json(201, created, true);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return json(413, { error: 'request body too large' }, true);
    throw error;
  }
}

async function handleLogsQueryRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/logs') return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const limitParam = url.searchParams.get('limit');
  const parsed = LogQueryRequestV1.safeParse({
    app_id: url.searchParams.get('app_id'),
    environment_id: url.searchParams.get('environment_id'),
    level: url.searchParams.get('level') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    event: url.searchParams.get('event') ?? undefined,
    limit: limitParam === null ? undefined : Number(limitParam),
  });
  if (!parsed.success) return json(400, { error: 'invalid log query' }, true);
  if (!ownerCanAccessApp(owner, parsed.data.app_id)) return productScopeForbidden();
  return json(
    200,
    await bundle.service.queryLogs(
      parsed.data.app_id,
      parsed.data.environment_id,
      {
        level: parsed.data.level,
        source: parsed.data.source,
        event: parsed.data.event,
        limit: parsed.data.limit,
      },
      Date.now(),
    ),
    true,
  );
}

async function handleAppsRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
  env: Env,
  ctx?: WorkerContext,
): Promise<Response | null> {
  if (url.pathname !== '/v1/apps') return null;
  const { service } = bundle;
  if (request.method === 'GET')
    return json(200, ListAppsResponseV1.parse(await service.listApps(owner.appId)), true);
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (owner.appId) return productScopeForbidden();
  try {
    const parsed = CreateAppRequestV1.safeParse(await readJsonBounded(request));
    if (!parsed.success) return json(400, { error: 'invalid app creation request' }, true);
    const created = await service.createApp(parsed.data, Date.now());
    await scheduleProductMilestone(env, 'project.created', created.app.id, ctx);
    return json(201, created, true);
  } catch (error) {
    if (error instanceof BodyTooLargeError)
      return json(413, { error: 'request body too large' }, true);
    throw error;
  }
}

const REVOKE_PATTERN = /^\/v1\/apps\/([^/]+)\/environments\/([^/]+)\/revoke$/;

async function handleRevokeRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  const revokeMatch = url.pathname.match(REVOKE_PATTERN);
  if (!revokeMatch) return null;
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (owner.appId || !ownerCanAccessApp(owner, revokeMatch[1])) return productScopeForbidden();
  const keyRecord = await bundle.repos.keys.getActiveKeyForEnvironment(
    revokeMatch[1],
    revokeMatch[2],
  );
  if (!keyRecord) return json(404, { error: 'no active key for environment' }, true);
  await bundle.service.revokeKey(keyRecord.id, Date.now());
  return json(200, { revoked: true, key_id: keyRecord.id }, true);
}

async function handleInstallationStatusRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/installation/status') return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const appId = url.searchParams.get('app_id');
  const envId = url.searchParams.get('environment_id');
  if (!appId || !envId) return json(400, { error: 'app_id and environment_id are required' });
  if (!ownerCanAccessApp(owner, appId)) return productScopeForbidden();
  return json(
    200,
    InstallationStatusV1.parse(await bundle.service.installationStatus(appId, envId, Date.now())),
    true,
  );
}

async function handleEndpointsRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/endpoints') return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const windowParam = (url.searchParams.get('window') ?? '15m') as Window;
  const parsed = EndpointQueryRequestV1.safeParse({
    app_id: url.searchParams.get('app_id'),
    environment_id: url.searchParams.get('environment_id'),
    window: WINDOWS.includes(windowParam) ? windowParam : 'invalid',
    sort: url.searchParams.get('sort') ?? 'health',
    sort_dir: url.searchParams.get('sort_dir') ?? 'desc',
  });
  if (!parsed.success) return json(400, { error: 'invalid query' });
  if (!ownerCanAccessApp(owner, parsed.data.app_id)) return productScopeForbidden();
  return json(
    200,
    await bundle.service.queryEndpoints(
      parsed.data.app_id,
      parsed.data.environment_id,
      parsed.data.window,
      Date.now(),
    ),
    true,
  );
}

async function handleFailuresRoute(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/v1/failures') return null;
  if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
  const parsed = FailureQueryRequestV1.safeParse({
    app_id: url.searchParams.get('app_id'),
    environment_id: url.searchParams.get('environment_id'),
    window: url.searchParams.get('window') ?? undefined,
    limit: Number(url.searchParams.get('limit') ?? DEFAULT_FAILURE_QUERY_LIMIT),
  });
  if (!parsed.success) return json(400, { error: 'invalid failure query' }, true);
  if (!ownerCanAccessApp(owner, parsed.data.app_id)) return productScopeForbidden();
  return json(
    200,
    await bundle.service.queryFailures(
      parsed.data.app_id,
      parsed.data.environment_id,
      parsed.data.window,
      parsed.data.limit,
      Date.now(),
    ),
    true,
  );
}

function handleEarlyRoutes(request: Request, env: Env, url: URL): Response | null {
  if (url.hostname !== env.APP_HEALTH_INGEST_HOST) {
    const agentResponse = handleAgentEdge(request);
    if (agentResponse) return agentResponse;
  }
  if (url.pathname === '/v1/health') return json(200, { ok: true });
  return null;
}

async function handleIngestHostRoutes(
  request: Request,
  bundle: AdapterBundle,
  env: Env,
  url: URL,
  ctx: WorkerContext | undefined,
): Promise<Response | null> {
  const browserResponse = await handleBrowserIngest(request, env, bundle.repos, bundle.local);
  if (browserResponse) return browserResponse;
  const nativeResponse = await handleNativeIngest(request, env, bundle.repos, bundle.local);
  if (nativeResponse) return nativeResponse;
  const ingestResponse = await handleIngestRoute(request, bundle, env, url);
  if (ingestResponse) return ingestResponse;
  const tracesResponse = await handleTracesRoute(request, bundle, env, url);
  if (tracesResponse) return tracesResponse;
  return handleLogsIngestRoute(request, bundle, env, url, ctx);
}

async function handleOwnerRoutes(
  request: Request,
  bundle: AdapterBundle,
  owner: OwnerIdentity,
  url: URL,
  env: Env,
  ctx?: WorkerContext,
): Promise<Response> {
  const shareResponse = await handleAnalyticsShareOwner(
    request,
    env,
    owner,
    bundle.repos,
    bundle.local,
  );
  if (shareResponse) return shareResponse;
  const nativeResponse = await handleNativeKeyOwner(
    request,
    env,
    owner,
    bundle.repos,
    bundle.local,
  );
  if (nativeResponse) return nativeResponse;
  const projectResponse = await handleProjectRoutes(request, bundle.repos, owner);
  if (projectResponse) return projectResponse;
  const browserResponse = await handleBrowserOwner(request, env, owner, bundle.local);
  if (browserResponse) return browserResponse;
  const handlers = [
    handleAppsRoute,
    handleRevokeRoute,
    handleInstallationStatusRoute,
    handleEndpointsRoute,
    handleFailuresRoute,
    handleLogsQueryRoute,
    handlePublicKeysRoute,
  ];
  for (const handler of handlers) {
    const response = await handler(request, bundle, owner, url, env, ctx);
    if (response) return response;
  }
  return json(404, { error: 'not found' });
}

async function handleAccountEntry(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname.startsWith('/v1/auth/')) {
    if (url.hostname !== env.APP_HEALTH_DASHBOARD_HOST) return json(404, { error: 'not found' });
    const auth = createAccountAuth(env);
    if (!auth) return json(503, { error: 'Google sign-in is not configured' }, true);
    const response = await auth.handler(request);
    response.headers.set('cache-control', 'no-store');
    return response;
  }
  if (
    url.pathname === '/v1/account/config' &&
    (env.APP_HEALTH_MODE === 'local' || url.hostname === env.APP_HEALTH_DASHBOARD_HOST)
  ) {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' }, true);
    return json(200, { google: accountsConfigured(env) }, true);
  }
  return null;
}

async function handleAccountOwner(
  request: Request,
  env: Env,
  url: URL,
  bundle: AdapterBundle,
  ctx?: WorkerContext,
): Promise<Response> {
  if (!accountMutationAllowed(request))
    return json(403, { error: 'same-origin request required' }, true);
  const account = await accountIdentity(request, env, (id) => {
    const delivery = scheduleProductMilestone(env, 'signup.completed', id, ctx);
    if (ctx) ctx.waitUntil(delivery);
    else void delivery;
  });
  if (!account || !env.DB) return json(401, { error: 'sign in required' }, true);
  if (url.pathname === '/v1/account' && request.method === 'GET')
    return json(200, { user: { name: account.owner.label }, workspace: account.workspace }, true);
  return handleOwnerRoutes(
    request,
    workspaceBundle(bundle, env.DB, account.workspace.id),
    account.owner,
    url,
    env,
    ctx,
  );
}

function workspaceBundle(
  bundle: AdapterBundle,
  db: D1DatabaseLike,
  workspaceId: string | null,
): AdapterBundle {
  const repos = new D1ControlPlane(db, workspaceId).asRepositories(bundle.repos.buckets);
  return { ...bundle, repos, service: new AppHealthService(repos) };
}

/** The pre-account owner key keeps access to unclaimed projects only. */
async function handleBearerOwner(
  request: Request,
  env: Env,
  url: URL,
  bundle: AdapterBundle,
  ctx?: WorkerContext,
): Promise<Response> {
  const owner = await bundle.identity.resolve(request);
  if (!owner) return json(403, { error: 'owner secret required' }, true);
  if (owner.appId || !env.DB) return handleOwnerRoutes(request, bundle, owner, url, env, ctx);
  const accountSchema =
    env.APP_HEALTH_ACCOUNTS ||
    (await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_apps'",
    ).first());
  if (!accountSchema) return handleOwnerRoutes(request, bundle, owner, url, env, ctx);
  const legacy = workspaceBundle(bundle, env.DB, null);
  const apps = await legacy.repos.apps.listApps();
  return handleOwnerRoutes(
    request,
    legacy,
    { ...owner, appIds: apps.map((app) => app.id) },
    url,
    env,
    ctx,
  );
}

async function publicAnalyticsPage(
  request: Request,
  assets: NonNullable<Env['ASSETS']>,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = '/live';
  const asset = await assets.fetch(new Request(url, request));
  const response = new Response(asset.body, asset);
  response.headers.delete('x-frame-options');
  const policy = (response.headers.get('content-security-policy') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\s/i.test(part));
  response.headers.set('content-security-policy', [...policy, 'frame-ancestors *'].join('; '));
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex, nofollow');
  return response;
}

const worker = {
  async fetch(request: Request, env: Env, ctx?: WorkerContext): Promise<Response> {
    const url = new URL(request.url);
    const earlyResponse = handleEarlyRoutes(request, env, url);
    if (earlyResponse) return earlyResponse;

    const selfConfig = selfAnalyticsConfig(request, env);
    if (selfConfig) return selfConfig;
    const authResponse = await handleAccountEntry(request, env, url);
    if (authResponse) return authResponse;
    const bundle = await resolveAdapter(env);
    if (!bundle) return json(503, { error: 'production bindings are incomplete' }, true);

    const ingestHostResponse = await handleIngestHostRoutes(request, bundle, env, url, ctx);
    if (ingestHostResponse) return ingestHostResponse;

    if (!hostAllowed(url, bundle, env, 'owner')) return json(404, { error: 'not found' });
    const sharedResponse = await handlePublicAnalytics(request, env, bundle.repos, bundle.local);
    if (sharedResponse) return sharedResponse;
    if (!url.pathname.startsWith('/v1/')) {
      if (request.method === 'GET' && env.ASSETS) {
        if (url.pathname === '/live') return publicAnalyticsPage(request, env.ASSETS);
        return env.ASSETS.fetch(request);
      }
      return json(404, { error: 'not found' });
    }

    if (env.APP_HEALTH_ACCOUNTS === 'enabled' && !request.headers.has('authorization')) {
      return handleAccountOwner(request, env, url, bundle, ctx);
    }
    return handleBearerOwner(request, env, url, bundle, ctx);
  },

  async scheduled(_controller: unknown, env: Env): Promise<void> {
    if (!env.DB) return;
    const control = new D1ControlPlane(env.DB);
    await control.cleanupExpired(Date.now() - DEDUPE_WINDOW_MS, 10_000);
    await control.cleanupFailuresExpired(Date.now() - 24 * 60 * 60 * 1000, 10_000);
    await control.cleanupLogsExpired(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000, 10_000);
    await control.cleanupBrowserQuotaExpired(Date.now() - 60 * 60 * 1000);
    if (env.APP_HEALTH_ACCOUNTS === 'enabled') {
      const accounts = await cleanupExpiredAccountRecords(env.DB);
      if (!accounts.ok) console.warn(JSON.stringify({ event: 'account_cleanup_failed' }));
    }
  },
};

export default worker;
export { InMemoryAdapter, AppHealthService };
export type { AppHealthRepositories, OwnerIdentityAdapter };
