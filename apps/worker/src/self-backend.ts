import { createAppHealthClient } from '@saas-maker/app-health';

export interface SelfBackendBindings {
  /** Dedicated environment-scoped private ingest key; never returned to browsers. */
  APP_HEALTH_SELF_BACKEND_KEY?: string;
  APP_HEALTH_DASHBOARD_HOST?: string;
  APP_HEALTH_INGEST_HOST?: string;
  APP_HEALTH_INGEST_ORIGIN?: string;
}

const ROUTES = new Set([
  '/v1/health',
  '/v1/account',
  '/v1/account/config',
  '/v1/product-analytics/config',
  '/v1/apps',
  '/v1/endpoints',
  '/v1/failures',
  '/v1/logs',
  '/v1/public-keys',
  '/v1/native-keys',
  '/v1/capabilities',
  '/v1/installation/status',
  '/v1/analytics',
  '/v1/analytics/report',
  '/v1/analytics/shares',
  '/v1/shared/analytics',
  '/v1/auth/get-session',
  '/v1/auth/sign-in/social',
  '/v1/auth/sign-out',
]);
const PARAMETER_ROUTES: [RegExp, string][] = [
  [/^\/v1\/apps\/[^/]+\/environments$/, '/v1/apps/:appId/environments'],
  [
    /^\/v1\/apps\/[^/]+\/environments\/[^/]+\/(keys|revoke)$/,
    '/v1/apps/:appId/environments/:environmentId/',
  ],
  [/^\/v1\/public-keys\/[^/]+\/revoke$/, '/v1/public-keys/:keyId/revoke'],
  [/^\/v1\/auth\/callback\/[^/]+$/, '/v1/auth/callback/:provider'],
];

function routeFor(request: Request, env: SelfBackendBindings): string | undefined {
  const url = new URL(request.url);
  if (url.host !== env.APP_HEALTH_DASHBOARD_HOST) return;
  if (request.method === 'OPTIONS' || request.headers.has('upgrade')) return;
  if (url.pathname === '/v1/logs' && request.method !== 'GET') return;
  if (ROUTES.has(url.pathname)) return url.pathname;
  for (const [pattern, route] of PARAMETER_ROUTES) {
    const match = url.pathname.match(pattern);
    if (match) return route + (match[1] ?? '');
  }
}

function clientFor(env: SelfBackendBindings) {
  if (!env.APP_HEALTH_SELF_BACKEND_KEY || !env.APP_HEALTH_INGEST_ORIGIN) return;
  const origin = new URL(env.APP_HEALTH_INGEST_ORIGIN);
  if (origin.protocol !== 'https:' || origin.host !== env.APP_HEALTH_INGEST_HOST) return;
  if (origin.username || origin.password) return;
  return createAppHealthClient({
    key: env.APP_HEALTH_SELF_BACKEND_KEY,
    endpoint: `${origin.origin}/v1/ingest`,
    runtime: 'worker',
    disableTimer: true,
    maxQueueSize: 1,
    maxBatchSize: 100,
    maxRetries: 1,
    requestTimeoutMs: 1500,
  });
}

function deliveryFailed(): void {
  // Never log exceptions: transport messages can contain request details.
  console.warn(JSON.stringify({ event: 'self_backend_delivery_failed' }));
}

export async function monitorSelfRequest(
  request: Request,
  env: SelfBackendBindings,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  handle: () => Promise<Response>,
): Promise<Response> {
  const started = performance.now();
  let status = 500;
  try {
    const response = await handle();
    status = response.status;
    return response;
  } finally {
    const duration = performance.now() - started;
    // A request-scoped client avoids cross-request I/O ownership in Workers.
    // Never await delivery on the response path, or measure ingestion itself.
    try {
      const route = routeFor(request, env);
      if (ctx && route && status !== 101) {
        const client = clientFor(env);
        if (client) {
          client.record({
            method: request.method,
            route,
            status_code: status,
            duration_ms: duration,
          });
          ctx.waitUntil(
            client
              .flush()
              .then(() => {
                if (client.diagnostics().failedBatches) deliveryFailed();
              })
              .catch(deliveryFailed),
          );
        }
      }
    } catch {
      deliveryFailed();
    }
  }
}
