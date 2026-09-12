interface ReportCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

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
): Promise<T> {
  const cacheKey = `${account}\0${workspace}\0${query}`;
  const key = new Request(
    `https://app-health.internal/analytics/${encodeURIComponent(account)}/${encodeURIComponent(workspace)}?query=${encodeURIComponent(query)}`,
  );
  try {
    const hit = await cache?.match(key);
    if (hit) return await hit.json<T>();
  } catch {
    // Cache availability never determines whether an authorized report can load.
  }
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
