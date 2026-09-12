// Cloudflare Pages Function adapter for @saas-maker/app-health/pages.
//
// Pages routing is file-based, so the caller supplies the trusted route
// template. The adapter deliberately never derives identity from request.url.

import { observe } from './observe.js';
import type { AppHealthClient } from './client.js';
import {
  normalizeMethod,
  normalizeRelease,
  normalizeRoutePath,
  normalizeStatus,
} from './normalize.js';

export interface PagesFunctionContext<
  Environment = Record<string, unknown>,
  Params extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
> {
  request: { readonly method: string };
  env: Environment;
  params: Record<Params, string | string[]>;
  data: Data;
  next(input?: unknown, init?: unknown): Promise<{ readonly status: number }>;
  waitUntil(promise: Promise<unknown>): void;
}

export type PagesFunctionHandler<
  Environment = Record<string, unknown>,
  Params extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
  ResponseType extends { readonly status: number } = { readonly status: number },
> = (
  context: PagesFunctionContext<Environment, Params, Data>,
) => ResponseType | Promise<ResponseType>;

type PagesClientResolver<Environment, Params extends string, Data extends Record<string, unknown>> =
  | AppHealthClient
  | ((context: PagesFunctionContext<Environment, Params, Data>) => AppHealthClient | null);

export interface PagesFunctionHealthOptions<
  Environment = Record<string, unknown>,
  Params extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Static framework route template, for example `/anime/:malId`. */
  route: string;
  /** A shared Worker client or a lazy resolver that may return null to disable collection. */
  client: PagesClientResolver<Environment, Params, Data>;
  /** Override the client's release for events emitted by this wrapper. */
  release?: string;
  /** Test/diagnostic hook. Receives only the approved endpoint summary fields. */
  onRecord?: (event: {
    method: string;
    route: string;
    status_code: number;
    duration_ms: number;
  }) => void;
}

/** Wrap a Pages Function while preserving its response and thrown errors. */
export function withPagesFunctionHealth<
  Environment = Record<string, unknown>,
  Params extends string = string,
  Data extends Record<string, unknown> = Record<string, unknown>,
  ResponseType extends { readonly status: number } = { readonly status: number },
>(
  options: PagesFunctionHealthOptions<Environment, Params, Data>,
  handler: PagesFunctionHandler<Environment, Params, Data, ResponseType>,
): PagesFunctionHandler<Environment, Params, Data, ResponseType> {
  const route = normalizeRoutePath(options.route);
  const release = normalizeRelease(options.release);
  return async (context): Promise<ResponseType> => {
    const start = nowMs();
    try {
      const response = await handler(context);
      observe(() => recordPages(context, options, route, release, response.status, start));
      return response;
    } catch (error) {
      observe(() => recordPages(context, options, route, release, 500, start));
      throw error;
    }
  };
}

function recordPages<Environment, Params extends string, Data extends Record<string, unknown>>(
  context: PagesFunctionContext<Environment, Params, Data>,
  options: PagesFunctionHealthOptions<Environment, Params, Data>,
  route: string | null,
  release: string | undefined,
  responseStatus: number,
  start: number,
): void {
  const method = normalizeMethod(context.request.method);
  const status = normalizeStatus(responseStatus);
  if (method === null || route === null || status === null) return;

  let client: AppHealthClient | null;
  try {
    client = typeof options.client === 'function' ? options.client(context) : options.client;
  } catch {
    return;
  }
  if (client === null) return;

  const event = {
    method,
    route,
    status_code: status,
    duration_ms: Math.max(0, Math.round(nowMs() - start)),
  };
  options.onRecord?.(event);
  client.record({
    ...event,
    ...(release !== undefined ? { release } : {}),
  });
  context.waitUntil(
    client.flush().catch(() => {
      // The client records bounded delivery failures in diagnostics.
    }),
  );
}

function nowMs(): number {
  const perf = globalThis.performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
