import { D1ControlPlane, type D1DatabaseLike } from './d1-adapter.js';
import { D1Capabilities } from './capability-store.js';

export interface SelfAnalyticsBindings {
  APP_HEALTH_SELF_APP_ID?: string;
  APP_HEALTH_SELF_ENVIRONMENT_ID?: string;
  APP_HEALTH_SELF_PUBLIC_KEY?: string;
  APP_HEALTH_INGEST_ORIGIN?: string;
  APP_HEALTH_DASHBOARD_HOST?: string;
  APP_HEALTH_MODE?: string;
  DB?: D1DatabaseLike;
}
type Milestone = 'signup.completed' | 'project.created';

export function selfAnalyticsConfig(request: Request, env: SelfAnalyticsBindings): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/product-analytics/config') return null;
  if (env.APP_HEALTH_MODE !== 'local' && url.hostname !== env.APP_HEALTH_DASHBOARD_HOST)
    return Response.json({ error: 'Not found' }, { status: 404 });
  if (request.method !== 'GET')
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  const publicKey = env.APP_HEALTH_SELF_PUBLIC_KEY;
  const ingestOrigin = env.APP_HEALTH_INGEST_ORIGIN;
  const configured = publicKey?.startsWith('ahk_pub_') && ingestOrigin;
  return Response.json(configured ? { publicKey, ingestOrigin } : null, {
    headers: { 'cache-control': 'public, max-age=60' },
  });
}

async function milestoneId(event: Milestone, entityId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${event}:${entityId}`)),
  );
  digest[6] = (digest[6] & 15) | 64;
  digest[8] = (digest[8] & 63) | 128;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Direct bindings avoid a recursive HTTP call into our own collector. */
export async function recordProductMilestone(
  env: SelfAnalyticsBindings,
  event: Milestone,
  entityId: string,
) {
  const app = env.APP_HEALTH_SELF_APP_ID;
  const environment = env.APP_HEALTH_SELF_ENVIRONMENT_ID;
  if (!env.DB || !app || !environment) return;
  try {
    const control = new D1ControlPlane(env.DB);
    if ((await control.getEnvironment(environment))?.app_id !== app) return;
    const now = Date.now();
    await control.recordLogs(
      app,
      environment,
      [
        {
          log_id: await milestoneId(event, entityId),
          timestamp: now,
          event,
          level: 'info',
          props: {},
          title: event === 'signup.completed' ? 'New signup' : 'Project created',
        },
      ],
      'server',
    );
    await new D1Capabilities(env.DB).recordCapability(app, environment, 'logs', now);
  } catch {
    console.warn(JSON.stringify({ event: 'self_analytics_delivery_failed', milestone: event }));
  }
}
export async function scheduleProductMilestone(
  env: SelfAnalyticsBindings,
  event: Milestone,
  entityId: string,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
) {
  const delivery = recordProductMilestone(env, event, entityId);
  if (ctx) ctx.waitUntil(delivery);
  else await delivery;
}
