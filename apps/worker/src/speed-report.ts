import {
  ALERT_WINDOW_MINUTES,
  BREACH_WINDOWS_LOOKBACK,
  MIN_ALERT_WINDOW_SAMPLES,
  MIN_WEB_VITAL_SAMPLES_PER_DAY,
  SERVER_TIME_BUDGETS_MS,
  STAGE_TIMING_EVENT,
  WEB_VITAL_BUDGETS,
  WEB_VITALS_EVENT,
  SpeedReportV1,
  WebVitalsProps,
  evaluateSustainedBreach,
  parseStageTiming,
  type SpeedReportQuery,
  type StageTimingProps,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { CatalogProductRow } from './daily-engagement-report.js';

const LOG_LIMIT = 20_000;
const PRODUCT_LIMIT = 56;
const ROUTE_LIMIT = 25;
const RANGE_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };
const WINDOW_MS = ALERT_WINDOW_MINUTES * 60_000;
const VITAL_METRICS = ['lcp_ms', 'inp_ms', 'ttfb_ms', 'cls_milli'] as const;
const SERVER_BUDGET = SERVER_TIME_BUDGETS_MS.api.read;

type CatalogRow = Pick<CatalogProductRow, 'catalog_id' | 'app_id' | 'catalog_name'>;
type Product = SpeedReportV1['products'][number];
type VitalRoute = Product['vitals']['routes'][number];
type ServerRoute = Product['server']['routes'][number];
type VitalBudget = typeof WEB_VITAL_BUDGETS.app | typeof WEB_VITAL_BUDGETS.landing;
interface LogRow {
  app_id: string;
  timestamp: number;
  props: string;
}
interface Sample<T> {
  timestamp: number;
  props: T;
}
interface ProductSamples {
  vitals: Sample<WebVitalsProps>[];
  server: Sample<StageTimingProps>[];
  rejected: number;
}

async function readCatalog(
  db: D1DatabaseLike,
  workspaceId: string,
  appId?: string,
): Promise<CatalogRow[]> {
  const result = await db
    .prepare(
      `SELECT c.catalog_id, c.app_id, c.catalog_name
       FROM catalog_project_imports c
       JOIN apps a ON a.id = c.app_id AND a.archived_at IS NULL
       WHERE c.workspace_id = ? AND c.lifecycle IN ('primary', 'active')
         AND EXISTS (SELECT 1 FROM environments e
           WHERE e.app_id = c.app_id AND lower(e.name) = 'production')
         ${appId === undefined ? '' : 'AND c.app_id = ?'}
       ORDER BY c.catalog_id LIMIT ${PRODUCT_LIMIT}`,
    )
    .bind(workspaceId, ...(appId === undefined ? [] : [appId]))
    .all<CatalogRow>();
  return result.results;
}

/**
 * Two event reads, not per-product queries. The catalog cap keeps binds below 100.
 * Server facts and browser claims are separate sources: stage timings are trusted only
 * from server logs, and web vitals only from browser logs.
 */
async function readLogs(
  db: D1DatabaseLike,
  catalog: readonly CatalogRow[],
  event: string,
  source: 'server' | 'browser',
  from: number,
  to: number,
): Promise<LogRow[]> {
  if (catalog.length === 0) return [];
  const result = await db
    .prepare(
      `SELECT l.app_id, l.timestamp, l.props
       FROM log_events l INDEXED BY idx_log_events_event_time
       JOIN environments e ON e.id = l.environment_id AND e.app_id = l.app_id
         AND lower(e.name) = 'production'
       WHERE l.event = ? AND l.timestamp >= ? AND l.timestamp < ? AND l.level = 'debug'
         AND l.source = ?
         AND l.app_id IN (${catalog.map(() => '?').join(',')})
       ORDER BY l.timestamp DESC LIMIT ${LOG_LIMIT}`,
    )
    .bind(event, from, to, source, ...catalog.map((row) => row.app_id))
    .all<LogRow>();
  return result.results;
}

function jsonProps(props: string): unknown {
  try {
    return JSON.parse(props);
  } catch {
    return null;
  }
}

function collectSamples(
  catalog: readonly CatalogRow[],
  server: readonly LogRow[],
  vitals: readonly LogRow[],
): Map<string, ProductSamples> {
  const products = new Map<string, ProductSamples>(
    catalog.map((row) => [row.app_id, { vitals: [], server: [], rejected: 0 }]),
  );
  for (const row of server) {
    const product = products.get(row.app_id);
    if (!product) continue;
    const parsed = parseStageTiming(jsonProps(row.props));
    if (parsed.ok) product.server.push({ timestamp: row.timestamp, props: parsed.value });
    else product.rejected++;
  }
  for (const row of vitals) {
    const product = products.get(row.app_id);
    if (!product) continue;
    const parsed = WebVitalsProps.safeParse(jsonProps(row.props));
    if (parsed.success) product.vitals.push({ timestamp: row.timestamp, props: parsed.data });
    else product.rejected++;
  }
  return products;
}

/** Nearest-rank percentile of observed samples; no interpolation or sampling uplift. */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function busiestGroups<T>(
  samples: readonly Sample<T>[],
  key: (props: T) => string,
): [string, Sample<T>[]][] {
  const groups = new Map<string, Sample<T>[]>();
  for (const sample of samples) {
    const name = key(sample.props);
    const group = groups.get(name) ?? [];
    group.push(sample);
    groups.set(name, group);
  }
  return [...groups].sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b));
}

function sustainedState<T>(
  samples: readonly Sample<T>[],
  metric: (props: T) => number | undefined,
  fraction: number,
  budget: number,
  now: number,
): ServerRoute['sustained'] {
  const windows: number[][] = Array.from({ length: BREACH_WINDOWS_LOOKBACK }, () => []);
  const start = now - BREACH_WINDOWS_LOOKBACK * WINDOW_MS;
  for (const sample of samples) {
    const index = Math.floor((sample.timestamp - start) / WINDOW_MS);
    const value = metric(sample.props);
    if (index >= 0 && index < windows.length && value !== undefined) windows[index].push(value);
  }
  return evaluateSustainedBreach(
    windows.map((values) => ({ samples: values.length, value: percentile(values, fraction) })),
    budget,
  );
}

function vitalRoute(
  route_group: string,
  samples: Sample<WebVitalsProps>[],
  budget: VitalBudget | null,
  now: number,
): VitalRoute {
  const route: VitalRoute = {
    route_group,
    samples: samples.length,
    lcp_ms: null,
    inp_ms: null,
    ttfb_ms: null,
    cls_milli: null,
    breaches: [],
    sustained: 'insufficient',
  };
  for (const metric of VITAL_METRICS) {
    const values = samples.flatMap(({ props }) =>
      props[metric] === undefined ? [] : [props[metric]],
    );
    if (values.length === 0) continue;
    const p75 = percentile(values, 0.75);
    route[metric] = { p75 };
    if (budget && values.length >= MIN_WEB_VITAL_SAMPLES_PER_DAY && p75 > budget[metric].p75)
      route.breaches.push({ metric, value: p75, budget: budget[metric].p75 });
  }
  if (budget && samples.length >= MIN_WEB_VITAL_SAMPLES_PER_DAY)
    route.sustained = sustainedState(samples, (p) => p.lcp_ms, 0.75, budget.lcp_ms.p75, now);
  return route;
}

function cacheCounts(samples: readonly Sample<StageTimingProps>[]): ServerRoute['cache'] {
  const counts = {
    HIT: 0,
    MISS: 0,
    EXPIRED: 0,
    BYPASS: 0,
    DYNAMIC: 0,
    STALE: 0,
    REVALIDATED: 0,
    NONE: 0,
  };
  for (const { props } of samples) counts[props.edge_cache]++;
  const denominator = samples.length - counts.NONE;
  return { ...counts, hit_ratio: denominator === 0 ? null : counts.HIT / denominator };
}

function stagePercentiles(samples: readonly Sample<StageTimingProps>[]): Record<string, number> {
  const stages = new Map<string, number[]>();
  for (const { props } of samples) {
    for (const [key, value] of Object.entries(props)) {
      if (key === 'total_ms' || !key.endsWith('_ms') || typeof value !== 'number') continue;
      const values = stages.get(key) ?? [];
      values.push(value);
      stages.set(key, values);
    }
  }
  return Object.fromEntries([...stages].map(([key, values]) => [key, percentile(values, 0.95)]));
}

function serverRoute(route: string, samples: Sample<StageTimingProps>[], now: number): ServerRoute {
  const values = samples.map(({ props }) => props.total_ms);
  const total_ms = {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
  };
  const sufficient = samples.length >= MIN_ALERT_WINDOW_SAMPLES;
  const breaches: ServerRoute['breaches'] = [];
  for (const metric of ['p50', 'p95', 'p99'] as const) {
    if (sufficient && total_ms[metric] > SERVER_BUDGET[metric])
      breaches.push({
        metric: `total_ms.${metric}`,
        value: total_ms[metric],
        budget: SERVER_BUDGET[metric],
      });
  }
  return {
    route,
    samples: samples.length,
    error_rate: samples.filter(({ props }) => props.status >= 500).length / samples.length,
    total_ms,
    cache: cacheCounts(samples),
    colos: busiestGroups(samples, (p) => p.colo)
      .slice(0, 5)
      .map(([colo, rows]) => ({
        colo,
        samples: rows.length,
        p95_ms: percentile(
          rows.map(({ props }) => props.total_ms),
          0.95,
        ),
      })),
    stages_p95_ms: stagePercentiles(samples),
    breaches,
    sustained: sufficient
      ? sustainedState(samples, (p) => p.total_ms, 0.95, SERVER_BUDGET.p95, now)
      : 'insufficient',
  };
}

function productState(samples: ProductSamples, budget: VitalBudget | null): Product['state'] {
  if (samples.vitals.length + samples.server.length === 0) return 'no_data';
  const serverMeasured = busiestGroups(samples.server, (p) => p.route).some(
    ([, rows]) => rows.length >= MIN_ALERT_WINDOW_SAMPLES,
  );
  const vitalsMeasured =
    budget !== null &&
    busiestGroups(samples.vitals, (p) => p.route_group).some(([, rows]) =>
      VITAL_METRICS.some(
        (metric) =>
          rows.filter(({ props }) => props[metric] !== undefined).length >=
          MIN_WEB_VITAL_SAMPLES_PER_DAY,
      ),
    );
  return serverMeasured || vitalsMeasured ? 'measured' : 'insufficient';
}

/** Breaching routes are never dropped by the display cap; the rest stay busiest-first. */
function capRoutes<T extends { breaches: unknown[]; sustained: string }>(routes: T[]): T[] {
  const flagged = (route: T) => route.breaches.length > 0 || route.sustained === 'breach';
  return [...routes.filter(flagged), ...routes.filter((route) => !flagged(route))].slice(
    0,
    ROUTE_LIMIT,
  );
}

function buildProduct(
  row: CatalogRow,
  samples: ProductSamples,
  budget: VitalBudget | null,
  now: number,
  truncated: { server: boolean; vitals: boolean },
): Product {
  return {
    catalog_id: row.catalog_id,
    app_id: row.app_id,
    name: row.catalog_name,
    state: productState(samples, budget),
    vitals: {
      samples: samples.vitals.length,
      truncated: truncated.vitals,
      routes: capRoutes(
        busiestGroups(samples.vitals, (p) => p.route_group).map(([name, rows]) =>
          vitalRoute(name, rows, budget, now),
        ),
      ),
    },
    server: {
      samples: samples.server.length,
      truncated: truncated.server,
      routes: capRoutes(
        busiestGroups(samples.server, (p) => p.route).map(([name, rows]) =>
          serverRoute(name, rows, now),
        ),
      ),
    },
    rejected: samples.rejected,
  };
}

/** Product-emitted stage logs are sampled; the report describes only retained samples. */
export async function readSpeedReport(args: {
  db: D1DatabaseLike;
  workspaceId: string;
  range: SpeedReportQuery['range'];
  now: number;
  appId?: string;
  performanceClass: SpeedReportQuery['class'];
}): Promise<SpeedReportV1> {
  const catalog = await readCatalog(args.db, args.workspaceId, args.appId);
  const from = args.now - RANGE_MS[args.range];
  const [server, vitals] = await Promise.all([
    readLogs(args.db, catalog, STAGE_TIMING_EVENT, 'server', from, args.now),
    readLogs(args.db, catalog, WEB_VITALS_EVENT, 'browser', from, args.now),
  ]);
  const samples = collectSamples(catalog, server, vitals);
  const budget = args.performanceClass === 'api' ? null : WEB_VITAL_BUDGETS[args.performanceClass];
  const truncated = { server: server.length === LOG_LIMIT, vitals: vitals.length === LOG_LIMIT };
  const products = catalog.map((row) =>
    buildProduct(row, samples.get(row.app_id)!, budget, args.now, truncated),
  );
  const summary = { measured: 0, no_data: 0, insufficient: 0, breaching: 0 };
  for (const product of products) {
    summary[product.state]++;
    if (
      [...product.vitals.routes, ...product.server.routes].some(
        (route) => route.breaches.length > 0 || route.sustained === 'breach',
      )
    )
      summary.breaching++;
  }
  return SpeedReportV1.parse({
    range: args.range,
    generated_at: args.now,
    class: args.performanceClass,
    budgets: { vitals: budget, server: SERVER_BUDGET },
    min_samples: {
      vitals: MIN_WEB_VITAL_SAMPLES_PER_DAY,
      server: MIN_ALERT_WINDOW_SAMPLES,
      alert_window: MIN_ALERT_WINDOW_SAMPLES,
    },
    products,
    summary,
  });
}
