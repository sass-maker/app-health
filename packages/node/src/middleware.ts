// Express middleware for @saas-maker/app-health/express.
//
// Captures method, framework route template (Express `baseUrl + route.path`
// after the response completes), status code, integer duration, timestamp,
// and optional release. If no Express route matched, the event is dropped;
// concrete request paths are never used as telemetry dimensions.
//
// Privacy: the middleware reads only `req.method`, `req.route.path`, and
// `res.statusCode`. It never reads a concrete path, headers,
// cookies, query values, route parameter values, request or response bodies,
// user identity, logs, stacks, or spans.
//
// The application response never awaits ingest. `record()` is non-blocking.

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { observe } from './observe.js';
import type { AppHealthClient } from './client.js';
import {
  normalizeMethod,
  normalizeRelease,
  normalizeRoutePath,
  normalizeStatus,
} from './normalize.js';

export interface ExpressMiddlewareOptions {
  client: AppHealthClient;
  /** Override the client's release for events emitted by this middleware. */
  release?: string;
  /**
   * Optional hook invoked after each completed request with the normalized
   * event fields. Useful for tests; never sent to ingest.
   */
  onRecord?: (event: {
    method: string;
    route: string;
    status_code: number;
    duration_ms: number;
  }) => void;
}

/**
 * Create Express middleware that records one endpoint summary per completed
 * request. The middleware calls `next()` immediately and records on the
 * `res.on('finish')` event, so it never delays the response.
 */
export function expressMiddleware(options: ExpressMiddlewareOptions): RequestHandler {
  const { client, onRecord } = options;
  const release = normalizeRelease(options.release);
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = nowMs();
    // `finish` fires after the response has been sent to the OS socket.
    res.on('finish', () =>
      observe(() => {
        const durationMs = Math.max(0, Math.round(nowMs() - start));
        const route = resolveExpressRoute(req);
        const method = normalizeMethod(req.method);
        const status = normalizeStatus(res.statusCode);
        if (method === null || route === null || status === null) return;
        onRecord?.({ method, route, status_code: status, duration_ms: durationMs });
        client.record({
          method,
          route,
          status_code: status,
          duration_ms: durationMs,
          ...(release !== undefined ? { release } : {}),
        });
      }),
    );
    next();
  };
}

/**
 * Resolve the route template for a completed Express request.
 * Uses `req.route.path`, the framework-native matched template. Express
 * `baseUrl` can contain concrete parent-router parameter values, so it is not
 * read. When no string template exists (including unmatched 404s), the event
 * is omitted.
 */
function resolveExpressRoute(req: Request): string | null {
  const routePath = req.route?.path;
  if (typeof routePath === 'string' && routePath.length > 0) {
    return normalizeRoutePath(routePath);
  }
  return null;
}

function nowMs(): number {
  // `performance.now()` is monotonic and available on Node 20+.
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
