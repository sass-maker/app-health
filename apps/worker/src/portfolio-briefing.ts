import {
  ANALYTICS_SOURCE_HOSTS,
  ANALYTICS_SOURCE_ALIASES,
  PortfolioBriefingV1,
  normalizeAnalyticsSource,
  type BriefingTraffic,
  type PortfolioBriefingV1 as PortfolioBriefing,
} from '@app-health/contracts';
import {
  botCounterCoverageSql,
  botCountersCoverDay,
  botSourceAggregateSql,
} from './browser-bot-counters.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import { dailyEngagementWindow, type CatalogProductRow } from './daily-engagement-report.js';

const DAY_MS = 86_400_000;
const MAX_CATALOG = 55;
const MAX_SOURCE_ROWS = 10_000;
const MAX_ANALYTICS_SQL_BYTES = 10_000;
const BOT_FILTER_CUTOVER = Date.UTC(2026, 9, 1, 6, 25, 40, 421);
const MIN_CURRENT = 20;
const MIN_GAIN = 10;
const MIN_RELATIVE_GAIN = 0.5;
const MIN_BASELINE = 5;
const SCOPE_ID = /^[a-zA-Z0-9_-]{1,100}$/;

type ScopeRow = CatalogProductRow;
type AnalyticsEngineQuery = (sql: string) => Promise<unknown[]>;
type BrowserApplicability = 'applicable' | 'not_applicable' | 'unknown';
interface CurrentReportProduct {
  app_id: string;
  browser_visitors: number | null;
  browser_visitors_applicability?: BrowserApplicability;
}

function browserNotApplicable(report: CurrentReportProduct | undefined): boolean {
  return report?.browser_visitors_applicability === 'not_applicable';
}

function sourcesStatus(
  row: ScopeRow,
  report: CurrentReportProduct | undefined,
  aggregates: SourceAggregates,
  pageviews: number | null,
): 'measured' | 'unknown' | 'not_applicable' {
  if (browserNotApplicable(report) || !row.environment_id) return 'not_applicable';
  return aggregates.measured && pageviews !== null ? 'measured' : 'unknown';
}

interface BriefingQueryRow {
  period: number | string;
  kind: string;
  app_id: string;
  name: string;
  pageviews: number | string;
  visitors: number | string;
  sample_interval: number | string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function numeric(value: unknown): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim() === '')
  )
    throw new Error('invalid briefing aggregate');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid briefing aggregate');
  return result;
}

async function readBriefingCatalog(db: D1DatabaseLike, workspaceId: string): Promise<ScopeRow[]> {
  if (!SCOPE_ID.test(workspaceId)) throw new Error('invalid workspace scope');
  const result = await db
    .prepare(
      `SELECT c.catalog_id, c.app_id, c.catalog_name, e.id AS environment_id,
       ac.first_received_at AS analytics_first_received_at
     FROM catalog_project_imports c
     LEFT JOIN environments e ON e.app_id = c.app_id AND lower(e.name) = 'production'
     LEFT JOIN environment_capabilities ac ON ac.app_id = c.app_id
       AND ac.environment_id = e.id AND ac.capability = 'analytics'
     WHERE c.workspace_id = ? AND c.lifecycle IN ('primary', 'active')
     ORDER BY c.catalog_id LIMIT ${MAX_CATALOG + 1}`,
    )
    .bind(workspaceId)
    .all<ScopeRow>();
  if (result.results.length > MAX_CATALOG) throw new Error('portfolio exceeds catalog capacity');
  const apps = new Set<string>();
  const ids = new Set<string>();
  for (const row of result.results) {
    if (
      !SCOPE_ID.test(row.app_id) ||
      !SCOPE_ID.test(row.catalog_id) ||
      (row.environment_id !== null && !SCOPE_ID.test(row.environment_id)) ||
      typeof row.catalog_name !== 'string' ||
      row.catalog_name.length < 1 ||
      row.catalog_name.length > 100 ||
      apps.has(row.app_id) ||
      ids.has(row.catalog_id)
    )
      throw new Error('invalid portfolio catalog scope');
    apps.add(row.app_id);
    ids.add(row.catalog_id);
  }
  return result.results;
}

function scopedEnvironmentList(catalog: readonly ScopeRow[]): string | null {
  const environments = [
    ...new Set(catalog.flatMap((row) => (row.environment_id ? [row.environment_id] : []))),
  ];
  return environments.length ? environments.map(quote).join(',') : null;
}

function sourceAggregateSql(
  workspaceId: string,
  catalog: readonly ScopeRow[],
  from: number,
  to: number,
): string | null {
  const environments = scopedEnvironmentList(catalog);
  if (!environments) return null;
  const allFrom = from - DAY_MS;
  const period = `IF(double2 >= ${from}, 1, 0)`;
  // Keep the SQL projection small enough for long imported environment IDs.
  // Canonicalise and merge these bounded raw values in canonicalSourceName.
  const sourceSql = `substring(lower(IF(blob17!='' OR blob10!='',blob10,blob6)),1,100)`;
  const filter = `index1 = ${quote(workspaceId)} AND double2 >= ${allFrom} AND double2 < ${to}
    AND blob2 IN (${environments})`;
  const sourceFrom = `FROM app_health_browser_v1 WHERE ${filter} AND blob3 = 'pageview'`;
  // Keep one source aggregate query. AE does not support UNION, so the distinct
  // browser baseline is read by its own bounded grouped query below.
  const sql = `SELECT ${period} AS period, 'source' AS kind, blob1 AS app_id, ${sourceSql} AS name,
      SUM(_sample_interval) AS pageviews, 0 AS visitors, MAX(_sample_interval) AS sample_interval
      ${sourceFrom} GROUP BY period, app_id, name LIMIT ${MAX_SOURCE_ROWS + 1}`;
  return sql.length <= MAX_ANALYTICS_SQL_BYTES ? sql : null;
}

function baselineAggregateSql(
  workspaceId: string,
  catalog: readonly ScopeRow[],
  from: number,
): string | null {
  const environments = scopedEnvironmentList(catalog);
  if (!environments) return null;
  const previousFrom = from - DAY_MS;
  const sql = `SELECT 0 AS period, 'baseline' AS kind, blob1 AS app_id, '__baseline__' AS name,
      0 AS pageviews, COUNT(DISTINCT blob8) AS visitors, MAX(_sample_interval) AS sample_interval
      FROM app_health_browser_v1 WHERE index1 = ${quote(workspaceId)}
      AND double2 >= ${previousFrom} AND double2 < ${from}
      AND blob2 IN (${environments}) AND blob8 != '' GROUP BY app_id LIMIT ${MAX_CATALOG + 1}`;
  return sql.length <= MAX_ANALYTICS_SQL_BYTES ? sql : null;
}

function rank(values: Map<string, number>, total: number, limit: number) {
  return [...values]
    .map(([name, pageviews]) => ({ name, pageviews, share: total ? pageviews / total : 0 }))
    .sort((a, b) => b.pageviews - a.pageviews || a.name.localeCompare(b.name))
    .slice(0, limit);
}

const KNOWN_SOURCES = new Set([
  ...ANALYTICS_SOURCE_HOSTS.map(([name]) => name),
  ...Object.values(ANALYTICS_SOURCE_ALIASES),
]);

function canonicalSourceName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid source name');
  if (value === '' || value === 'Unknown' || value === 'No referrer') return 'No referrer';
  const normalized = normalizeAnalyticsSource(value);
  if (KNOWN_SOURCES.has(normalized)) return normalized;
  // Preserve actionable source tags/domains, while rejecting URLs, credentials,
  // paths, queries, and other raw referrer content.
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) ? value.toLowerCase() : 'Other referral';
}

interface SourceAggregates {
  rowsByApp: Map<string, { current: Map<string, number>; previous: Map<string, number> }>;
  previousVisitors: Map<string, number>;
  estimatedApps: Set<string>;
  periodsByApp: Map<string, Set<number>>;
  measured: boolean;
}

function emptySourceAggregates(): SourceAggregates {
  return {
    rowsByApp: new Map(),
    previousVisitors: new Map(),
    estimatedApps: new Set(),
    periodsByApp: new Map(),
    measured: false,
  };
}

function recordSource(row: BriefingQueryRow, state: SourceAggregates, period: number): void {
  const sample = numeric(row.sample_interval);
  if (sample < 1) throw new Error('invalid source sampling');
  const groups = state.rowsByApp.get(row.app_id) ?? { current: new Map(), previous: new Map() };
  const target = period === 1 ? groups.current : groups.previous;
  const name = canonicalSourceName(row.name);
  target.set(name, (target.get(name) ?? 0) + numeric(row.pageviews));
  state.rowsByApp.set(row.app_id, groups);
  if (sample !== 1) state.estimatedApps.add(row.app_id);
  const periods = state.periodsByApp.get(row.app_id) ?? new Set<number>();
  periods.add(period);
  state.periodsByApp.set(row.app_id, periods);
}

function recordSourceRow(
  row: BriefingQueryRow,
  state: SourceAggregates,
  allowedApps: ReadonlySet<string>,
): void {
  if (!allowedApps.has(row.app_id)) throw new Error('invalid source scope');
  if (row.period !== 0 && row.period !== 1 && row.period !== '0' && row.period !== '1')
    throw new Error('invalid source period');
  const period = Number(row.period);
  if (row.kind === 'source') recordSource(row, state, period);
  else throw new Error('invalid aggregate kind');
}

function parseSourceRows(rows: BriefingQueryRow[], catalog: readonly ScopeRow[]): SourceAggregates {
  if (rows.length > MAX_SOURCE_ROWS) throw new Error('source aggregate overflow');
  const state = emptySourceAggregates();
  if (rows.length === MAX_SOURCE_ROWS) return state;
  const allowedApps = new Set(catalog.map((row) => row.app_id));
  for (const row of rows) {
    if (row.kind !== 'source') throw new Error('invalid source aggregate kind');
    recordSourceRow(row, state, allowedApps);
  }
  state.measured = true;
  return state;
}

function parseBaselineRows(
  rows: BriefingQueryRow[],
  catalog: readonly ScopeRow[],
): Map<string, number> {
  if (rows.length > MAX_CATALOG) throw new Error('baseline aggregate overflow');
  const allowedApps = new Set(catalog.map((row) => row.app_id));
  const visitors = new Map<string, number>();
  for (const row of rows) {
    if (
      row.kind !== 'baseline' ||
      (row.period !== 0 && row.period !== '0') ||
      !allowedApps.has(row.app_id) ||
      visitors.has(row.app_id)
    )
      throw new Error('invalid baseline scope');
    const sample = numeric(row.sample_interval);
    if (sample < 1) throw new Error('invalid baseline sampling');
    if (sample === 1) visitors.set(row.app_id, numeric(row.visitors));
  }
  return visitors;
}

async function loadSourceAggregates(args: {
  query?: AnalyticsEngineQuery;
  workspaceId: string;
  catalog: readonly ScopeRow[];
  from: number;
  to: number;
}): Promise<SourceAggregates> {
  if (!args.query) return emptySourceAggregates();
  const sourceSql = sourceAggregateSql(args.workspaceId, args.catalog, args.from, args.to);
  const baselineSql = baselineAggregateSql(args.workspaceId, args.catalog, args.from);
  if (!sourceSql) return emptySourceAggregates();
  const [sourceResult, baselineResult] = await Promise.allSettled([
    args.query(sourceSql),
    baselineSql ? args.query(baselineSql) : Promise.reject(new Error('baseline query unavailable')),
  ]);
  if (sourceResult.status === 'rejected') return emptySourceAggregates();
  let sources: SourceAggregates;
  try {
    sources = parseSourceRows(sourceResult.value as BriefingQueryRow[], args.catalog);
  } catch {
    return emptySourceAggregates();
  }
  if (baselineResult.status === 'fulfilled') {
    try {
      sources.previousVisitors = parseBaselineRows(
        baselineResult.value as BriefingQueryRow[],
        args.catalog,
      );
    } catch {
      // Current source totals remain useful even when comparison evidence fails.
    }
  }
  return sources;
}

/** Bot counters: current-day pageviews by source, measured only with full-day coverage. */
async function loadBotAggregates(args: {
  query?: AnalyticsEngineQuery;
  catalog: readonly ScopeRow[];
  from: number;
  to: number;
}): Promise<SourceAggregates> {
  const environments = scopedEnvironmentList(args.catalog);
  if (!args.query || !environments) return emptySourceAggregates();
  const scoped = args.catalog.filter((row) => row.environment_id).map((row) => row.app_id);
  const sql = botSourceAggregateSql(scoped, environments, args.from, args.to, MAX_SOURCE_ROWS);
  if (sql.length > MAX_ANALYTICS_SQL_BYTES) return emptySourceAggregates();
  try {
    const [rows, coverage] = await Promise.all([
      args.query(sql),
      args.query(botCounterCoverageSql(args.from, args.to)),
    ]);
    if (!botCountersCoverDay(coverage, args.from, args.to)) return emptySourceAggregates();
    return parseSourceRows(rows as BriefingQueryRow[], args.catalog);
  } catch {
    return emptySourceAggregates();
  }
}

/** All traffic: per-source sums of non-bot and bot pageviews; unknown if either is. */
function mergeAggregates(nonBot: SourceAggregates, bots: SourceAggregates): SourceAggregates {
  if (!nonBot.measured || !bots.measured) return emptySourceAggregates();
  const merged = emptySourceAggregates();
  merged.measured = true;
  for (const state of [nonBot, bots]) {
    for (const [appId, groups] of state.rowsByApp) {
      const target = merged.rowsByApp.get(appId) ?? { current: new Map(), previous: new Map() };
      for (const [name, count] of groups.current)
        target.current.set(name, (target.current.get(name) ?? 0) + count);
      merged.rowsByApp.set(appId, target);
    }
    for (const appId of state.estimatedApps) merged.estimatedApps.add(appId);
  }
  return merged;
}

async function loadTrafficAggregates(
  traffic: BriefingTraffic,
  args: Parameters<typeof loadSourceAggregates>[0],
): Promise<SourceAggregates> {
  const nonBot = traffic === 'bots' ? emptySourceAggregates() : loadSourceAggregates(args);
  if (traffic === 'non_bot') return nonBot;
  const [human, bots] = await Promise.all([nonBot, loadBotAggregates(args)]);
  return traffic === 'bots' ? bots : mergeAggregates(human, bots);
}

interface SourceTotals {
  pageviewsByApp: Map<string, number>;
  sourceCountsByApp: Map<string, Map<string, number>>;
  allSources: Map<string, number>;
  pageviews: number;
}

function portfolioSourceTotals(
  catalog: readonly ScopeRow[],
  aggregates: SourceAggregates,
  dayStart: number,
  currentByApp: ReadonlyMap<string, CurrentReportProduct>,
): SourceTotals {
  const totals: SourceTotals = {
    pageviewsByApp: new Map(),
    sourceCountsByApp: new Map(),
    allSources: new Map(),
    pageviews: 0,
  };
  for (const row of catalog) {
    if (browserNotApplicable(currentByApp.get(row.app_id))) continue;
    const covered =
      row.analytics_first_received_at !== null && row.analytics_first_received_at <= dayStart;
    if (!aggregates.measured || !row.environment_id || !covered) continue;
    const sources = aggregates.rowsByApp.get(row.app_id)?.current ?? new Map<string, number>();
    const pageviews = [...sources.values()].reduce((sum, value) => sum + value, 0);
    totals.pageviewsByApp.set(row.app_id, pageviews);
    totals.sourceCountsByApp.set(row.app_id, sources);
    totals.pageviews += pageviews;
    for (const [name, count] of sources)
      totals.allSources.set(name, (totals.allSources.get(name) ?? 0) + count);
  }
  return totals;
}

interface ComparisonResult {
  change: number | null;
  breakout: boolean;
  reason: string;
}

function assessComparison(args: {
  allowed: boolean;
  coverage: boolean;
  current: number | null;
  previous: number | null;
  estimated: boolean;
  sourceCoverage: boolean;
}): ComparisonResult {
  const { allowed, coverage, current, previous, estimated, sourceCoverage } = args;
  if (!allowed)
    return {
      change: null,
      breakout: false,
      reason: 'Comparison suppressed across bot-filter rollout.',
    };
  if (current === null)
    return {
      change: null,
      breakout: false,
      reason: 'Current browser count is unknown or sampled.',
    };
  if (previous === null)
    return {
      change: null,
      breakout: false,
      reason: 'Previous daily browser baseline is unavailable or sampled.',
    };
  if (!coverage)
    return {
      change: null,
      breakout: false,
      reason: 'Analytics coverage began after the prior day started.',
    };
  if (estimated) return { change: null, breakout: false, reason: 'Source counts are sampled.' };
  if (!sourceCoverage)
    return {
      change: null,
      breakout: false,
      reason: 'Unsampled source coverage is incomplete for both days.',
    };
  const change = current - previous;
  if (previous < MIN_BASELINE)
    return {
      change,
      breakout: false,
      reason: 'Previous browser baseline is too small for a breakout.',
    };
  const breakout =
    current >= MIN_CURRENT && change >= MIN_GAIN && change / previous >= MIN_RELATIVE_GAIN;
  return {
    change,
    breakout,
    reason: breakout
      ? 'Browser visitors rose at least 50%, with at least 20 current visitors and 10 net visitors.'
      : 'No high-confidence browser breakout meets the minimum thresholds.',
  };
}

interface ProductBuildContext {
  report?: CurrentReportProduct;
  aggregates: SourceAggregates;
  totals: SourceTotals;
  comparisonsAllowed: boolean;
  priorFrom: number;
  traffic: BriefingTraffic;
}

const TRAFFIC_COMPARISON_REASON = {
  bots: 'Bot counters keep no browser identity, so bot traffic has no breakouts.',
  all: 'Breakouts compare non-bot browsers only; select Non-bot to see them.',
} as const;

function hasBothPeriods(aggregates: SourceAggregates, appId: string): boolean {
  const periods = aggregates.periodsByApp.get(appId);
  return Boolean(periods?.has(0) && periods.has(1));
}

function buildBriefingProduct(row: ScopeRow, context: ProductBuildContext) {
  const { report, aggregates, totals, comparisonsAllowed, priorFrom, traffic } = context;
  const covered =
    row.analytics_first_received_at !== null && row.analytics_first_received_at <= priorFrom;
  const previous = comparisonsAllowed
    ? (aggregates.previousVisitors.get(row.app_id) ?? null)
    : null;
  const comparison =
    traffic === 'non_bot'
      ? assessComparison({
          allowed: comparisonsAllowed,
          coverage: covered,
          current: report?.browser_visitors ?? null,
          previous,
          estimated: aggregates.estimatedApps.has(row.app_id),
          sourceCoverage: hasBothPeriods(aggregates, row.app_id),
        })
      : { change: null, breakout: false, reason: TRAFFIC_COMPARISON_REASON[traffic] };
  const notApplicable = browserNotApplicable(report);
  const pageviews = notApplicable ? null : (totals.pageviewsByApp.get(row.app_id) ?? null);
  const sources = totals.sourceCountsByApp.get(row.app_id) ?? new Map<string, number>();
  return {
    app_id: row.app_id,
    catalog_id: row.catalog_id,
    name: row.catalog_name,
    pageviews,
    top_sources: pageviews === null ? [] : rank(sources, pageviews, 5),
    sources_status: sourcesStatus(row, report, aggregates, pageviews),
    source_estimated: aggregates.estimatedApps.has(row.app_id),
    previous_browser_visitors: traffic === 'non_bot' ? previous : null,
    browser_change: comparison.change,
    breakout: comparison.breakout,
    comparison_reason: comparison.reason,
  };
}

/** Read one completed India day for the owner workspace, with no per-product AE requests. */
export async function readPortfolioBriefing(args: {
  db: D1DatabaseLike;
  workspaceId: string;
  date: string | null;
  now: number;
  currentReport:
    | { products: readonly CurrentReportProduct[] }
    | Promise<{ products: readonly CurrentReportProduct[] }>;
  query?: AnalyticsEngineQuery;
  traffic?: BriefingTraffic;
}): Promise<PortfolioBriefing> {
  const traffic = args.traffic ?? 'non_bot';
  const window = dailyEngagementWindow(args.date, args.now);
  if ('error' in window) throw Object.assign(new Error(window.error), { status: 400 });
  const [sourceData, currentReport] = await Promise.all([
    readBriefingCatalog(args.db, args.workspaceId).then(async (catalog) => ({
      catalog,
      aggregates: await loadTrafficAggregates(traffic, {
        query: args.query,
        workspaceId: args.workspaceId,
        catalog,
        from: window.from,
        to: window.to,
      }),
    })),
    args.currentReport,
  ]);
  const { catalog, aggregates } = sourceData;
  const currentByApp = indexCurrentReport(currentReport.products, catalog);
  const priorFrom = window.from - DAY_MS;
  const comparisonsAllowed = window.to <= BOT_FILTER_CUTOVER || priorFrom >= BOT_FILTER_CUTOVER;
  const totals = portfolioSourceTotals(catalog, aggregates, window.from, currentByApp);
  const context: ProductBuildContext = {
    aggregates,
    totals,
    comparisonsAllowed,
    priorFrom,
    traffic,
  };
  const products = catalog.map((row) =>
    buildBriefingProduct(row, { ...context, report: currentByApp.get(row.app_id) }),
  );

  return PortfolioBriefingV1.parse({
    date: window.date,
    timezone: 'Asia/Kolkata',
    traffic,
    generated_at: args.now,
    products,
    sources: rank(totals.allSources, totals.pageviews, 10),
    comparison_note:
      traffic !== 'non_bot'
        ? TRAFFIC_COMPARISON_REASON[traffic]
        : comparisonsAllowed
          ? 'Compared with the previous Asia/Kolkata day within the same bot-filter regime; breakout needs 20 current visitors, 10 net gain, 50% growth, and a baseline of at least 5.'
          : `Comparison suppressed because the current and prior days cross the bot-filter cutover (${new Date(BOT_FILTER_CUTOVER).toISOString()}); Oct 2 is the first fully filtered day.`,
    filter_note: TRAFFIC_FILTER_NOTE[traffic],
  });
}

const TRAFFIC_FILTER_NOTE = {
  non_bot:
    'Analytics Engine browser events are counted in pageview units; no-referrer traffic is shown as “No referrer”.',
  bots: 'Known-bot pageviews from retained counters, by receipt time; unknown until the counting collector covered the whole day.',
  all: 'Non-bot plus known-bot pageviews; unknown when either side is unknown. Unrecognized automation stays in Non-bot.',
} as const;

function indexCurrentReport(
  rows: readonly CurrentReportProduct[],
  catalog: readonly ScopeRow[],
): Map<string, CurrentReportProduct> {
  const allowedApps = new Set(catalog.map((row) => row.app_id));
  const indexed = new Map<string, CurrentReportProduct>();
  for (const row of rows) {
    if (
      !allowedApps.has(row.app_id) ||
      indexed.has(row.app_id) ||
      (row.browser_visitors !== null &&
        (!Number.isSafeInteger(row.browser_visitors) || row.browser_visitors < 0)) ||
      (row.browser_visitors_applicability !== undefined &&
        !['applicable', 'not_applicable', 'unknown'].includes(row.browser_visitors_applicability))
    )
      throw new Error('current report does not match portfolio scope');
    indexed.set(row.app_id, row);
  }
  return indexed;
}
