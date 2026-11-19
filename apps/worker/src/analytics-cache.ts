import type { D1DatabaseLike } from './d1-adapter.js';
import type { PortfolioAnalyticsSnapshot } from './catalog-inventory.js';
interface ReportCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

type AnalyticsCacheTimings = { analyticsCacheLookupMs?: number };

const noCache = {};
const inflightByCache = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Internal, workspace-scoped cache; callers authenticate before reaching it. */
export async function cachedAnalytics<T>(
  account: string,
  workspace: string,
  query: string,
  load: () => Promise<T>,
  cache: ReportCache | undefined = typeof caches === 'undefined' ? undefined : caches.default,
  maxAge = 60,
  timings?: AnalyticsCacheTimings,
): Promise<T> {
  const cacheKey = `${account}\0${workspace}\0${query}`;
  const key = new Request(
    `https://app-health.internal/analytics/${encodeURIComponent(account)}/${encodeURIComponent(workspace)}?query=${encodeURIComponent(query)}`,
  );
  let hit: T | undefined;
  let cacheHit = false;
  const cacheLookupStarted = timings ? performance.now() : undefined;
  try {
    const cached = await cache?.match(key);
    if (cached) {
      hit = await cached.json<T>();
      cacheHit = true;
    }
  } catch {
    // Cache availability never determines whether an authorized report can load.
  } finally {
    if (timings && cacheLookupStarted !== undefined)
      timings.analyticsCacheLookupMs = performance.now() - cacheLookupStarted;
  }
  if (cacheHit) return hit as T;
  const owner = cache ?? noCache;
  let inflight = inflightByCache.get(owner);
  if (!inflight) {
    inflight = new Map();
    inflightByCache.set(owner, inflight);
  }
  const current = inflight.get(cacheKey);
  if (current) return (await current) as T;
  const pending = (async () => {
    const value = await load();
    try {
      await cache?.put(
        key,
        Response.json(value, { headers: { 'cache-control': `max-age=${maxAge}` } }),
      );
    } catch {
      // A failed cache write must not discard a successfully queried report.
    }
    return value;
  })();
  if (inflight.size < 128) {
    inflight.set(cacheKey, pending);
    pending.then(
      () => inflight?.get(cacheKey) === pending && inflight.delete(cacheKey),
      () => inflight?.get(cacheKey) === pending && inflight.delete(cacheKey),
    );
  }
  return pending;
}

/** The revision fences both Cloudflare entries and in-flight reads across catalog changes. */
export async function snapshotCachedAnalytics<T>(
  source: D1DatabaseLike | Pick<PortfolioAnalyticsSnapshot, 'projectionHash'> | undefined,
  account: string,
  workspace: string,
  query: string,
  load: () => Promise<T>,
  cache?: ReportCache,
  maxAge = 60,
  timings?: AnalyticsCacheTimings,
): Promise<T> {
  const projectionHash =
    source && 'projectionHash' in source
      ? source.projectionHash
      : ((
          await source
            ?.prepare(
              'SELECT projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = ?',
            )
            .bind(workspace)
            .first<{ projection_hash: string }>()
        )?.projection_hash ?? 'manual');
  return cachedAnalytics(
    account,
    workspace,
    `${projectionHash}:${query}`,
    load,
    cache,
    maxAge,
    timings,
  );
}
