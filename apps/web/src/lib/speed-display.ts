import type { SpeedReportV1 } from '@app-health/contracts';

export type SpeedProduct = SpeedReportV1['products'][number];
export type VitalRoute = SpeedProduct['vitals']['routes'][number];
export type ServerRoute = SpeedProduct['server']['routes'][number];
export type VitalMetric = 'lcp_ms' | 'inp_ms' | 'cls_milli' | 'ttfb_ms';
export type MetricKey = VitalMetric | 'server' | 'errors' | 'cache' | 'samples';
export type SpeedSort = 'name' | 'state' | MetricKey;

export const vitalColumns: { key: VitalMetric; label: string }[] = [
  { key: 'lcp_ms', label: 'LCP p75' },
  { key: 'inp_ms', label: 'INP p75' },
  { key: 'cls_milli', label: 'CLS p75' },
  { key: 'ttfb_ms', label: 'TTFB p75' },
];

export const stateLabels = {
  measured: 'Measured',
  insufficient: 'Insufficient samples',
  no_data: 'No data',
};

export function isBreaching(product: SpeedProduct): boolean {
  return [...product.vitals.routes, ...product.server.routes].some(
    (route) => route.breaches.length > 0 || route.sustained === 'breach',
  );
}

function worst(values: (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => value != null);
  return known.length ? Math.max(...known) : null;
}

function serverRate(product: SpeedProduct, key: 'errors' | 'cache'): number | null {
  const routes = product.server.routes;
  const samples = routes.reduce((total, route) => total + route.samples, 0);
  if (key === 'errors') {
    return samples
      ? routes.reduce((sum, route) => sum + route.error_rate * route.samples, 0) / samples
      : null;
  }
  const denominator = samples - routes.reduce((sum, route) => sum + route.cache.NONE, 0);
  return denominator ? routes.reduce((sum, route) => sum + route.cache.HIT, 0) / denominator : null;
}

export function productMetric(product: SpeedProduct, key: MetricKey): number | null {
  if (key === 'samples') return product.vitals.samples + product.server.samples || null;
  if (key === 'server') return worst(product.server.routes.map((route) => route.total_ms.p95));
  if (key === 'errors' || key === 'cache') return serverRate(product, key);
  return worst(product.vitals.routes.map((route) => route[key]?.p75));
}

export function metricBreaches(product: SpeedProduct, key: MetricKey): boolean {
  if (key === 'server')
    return product.server.routes.some(
      (route) =>
        route.breaches.some((breach) => breach.metric === 'total_ms.p95') ||
        route.sustained === 'breach',
    );
  return product.vitals.routes.some(
    (route) =>
      route.breaches.some((breach) => breach.metric === key) ||
      (key === 'lcp_ms' && route.sustained === 'breach'),
  );
}

export function formatSpeed(value: number, key: string): string {
  if (key === 'cls_milli') return String(Number((value / 1000).toFixed(3)));
  if (key === 'errors' || key === 'cache') return `${Number((value * 100).toFixed(1))}%`;
  if (key === 'samples') return value.toLocaleString();
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
}

function sortValue(product: SpeedProduct, key: SpeedSort): string | number | null {
  if (key === 'name') return product.name;
  if (key === 'state') return `${Number(!isBreaching(product))}${stateLabels[product.state]}`;
  return productMetric(product, key);
}

export function sortSpeedProducts(
  products: SpeedProduct[],
  key: SpeedSort,
  ascending: boolean,
): SpeedProduct[] {
  return [...products].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    // Missing readings stay last in both directions.
    if (av === null) return bv === null ? a.name.localeCompare(b.name) : 1;
    if (bv === null) return -1;
    const comparison =
      typeof av === 'string' && typeof bv === 'string'
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    return comparison * (ascending ? 1 : -1) || a.name.localeCompare(b.name);
  });
}
