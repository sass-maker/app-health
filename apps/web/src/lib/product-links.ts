export interface ProductAnalyticsTarget {
  appId: string;
  environmentId: string;
}

export function productAnalyticsHref(target: ProductAnalyticsTarget): string;
export function productAnalyticsHref(appId: string, environmentId: string): string;
export function productAnalyticsHref(
  targetOrAppId: ProductAnalyticsTarget | string,
  environmentId?: string,
): string {
  const target =
    typeof targetOrAppId === 'string'
      ? { appId: targetOrAppId, environmentId: environmentId ?? '' }
      : targetOrAppId;
  const params = new URLSearchParams({ project: target.appId, environment: target.environmentId });
  return `/app?${params.toString()}#analytics`;
}
