interface ReportCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Internal, workspace-scoped cache; callers authenticate before reaching it. */
export async function cachedAnalytics<T>(
  account: string,
  workspace: string,
  query: string,
  load: () => Promise<T>,
  cache: ReportCache | undefined = typeof caches === 'undefined' ? undefined : caches.default,
  maxAge = 60,
): Promise<T> {
  const key = new Request(
    `https://app-health.internal/analytics/${encodeURIComponent(account)}/${encodeURIComponent(workspace)}?query=${encodeURIComponent(query)}`,
  );
  try {
    const hit = await cache?.match(key);
    if (hit) return await hit.json<T>();
  } catch {
    // Cache availability never determines whether an authorized report can load.
  }
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
}
