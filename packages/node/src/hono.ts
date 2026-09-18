// Hono adapter for @saas-maker/app-health/hono.
//
// The adapter reads only Hono's matched route template, the request method,
// the final response status, and the declared response content-length as a
// byte-count scalar. It never reads the concrete URL, header values, cookies,
// query values, params, bodies, identity, logs, stacks, or spans.

import type { Context, Env, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { observe } from './observe.js';
import type { AppHealthClient } from './client.js';
import {
  normalizeMethod,
  normalizeRelease,
  normalizeRoutePath,
  normalizeStatus,
} from './normalize.js';

type ClientResolver<E extends Env> =
  AppHealthClient | ((context: Context<E>) => AppHealthClient | null);

export interface HonoMiddlewareOptions<E extends Env = Env> {
  /** A shared Worker client or a lazy resolver that may return null to disable collection. */
  client: ClientResolver<E>;
  /** Override the client's release for events emitted by this middleware. */
  release?: string;
  /** Test/diagnostic hook. Receives only the approved endpoint summary fields. */
  onRecord?: (event: {
    method: string;
    route: string;
    status_code: number;
    duration_ms: number;
    response_bytes?: number;
  }) => void;
}

/** Record Hono endpoint health without delaying or changing the response. */
export function honoMiddleware<E extends Env = Env>(
  options: HonoMiddlewareOptions<E>,
): MiddlewareHandler<E> {
  const release = normalizeRelease(options.release);
  return async (context, next): Promise<void> => {
    const start = nowMs();
    try {
      await next();
    } catch (error) {
      observe(() => recordHono(context, options, release, 500, start));
      throw error;
    }
    observe(() => recordHono(context, options, release, context.res.status, start));
  };
}

function recordHono<E extends Env>(
  context: Context<E>,
  options: HonoMiddlewareOptions<E>,
  release: string | undefined,
  responseStatus: number,
  start: number,
): void {
  const method = normalizeMethod(context.req.method);
  const route = normalizeRoutePath(routePath(context, -1));
  const status = normalizeStatus(responseStatus);
  if (method === null || route === null || status === null) return;

  let client: AppHealthClient | null;
  try {
    client = typeof options.client === 'function' ? options.client(context) : options.client;
  } catch {
    return;
  }
  if (client === null) return;

  const contentLength = context.res.headers.get('content-length');
  const declaredBytes = contentLength === null ? undefined : Number(contentLength);
  const event = {
    method,
    route,
    status_code: status,
    duration_ms: Math.max(0, Math.round(nowMs() - start)),
    ...(declaredBytes !== undefined && Number.isInteger(declaredBytes) && declaredBytes >= 0
      ? { response_bytes: declaredBytes }
      : {}),
  };
  options.onRecord?.(event);
  client.record({
    ...event,
    ...(release !== undefined ? { release } : {}),
  });
  registerWaitUntil(context, client.flush());
}

function registerWaitUntil(context: Context, delivery: Promise<void>): void {
  try {
    context.executionCtx.waitUntil(delivery);
  } catch {
    void delivery.catch(() => {
      // The client records bounded delivery failures in diagnostics.
    });
  }
}

function nowMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
