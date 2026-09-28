// Bounded owner-only daily engagement report across the workspace's declared
// catalog products. Reports one completed Asia/Kolkata day using grouped Analytics
// Engine queries (browser visitors + CTA events) and a grouped D1 log_events
// query (feedback / waitlist / newsletter joins). No per-app query loops.
//
// Privacy: only counts, canonical IDs, and freshness timestamps leave this
// module. Centralized SaaS Maker log props (project_id/project/type/kind) are
// resolved to a catalog_id and discarded; submitted content, email, headers,
// cookies, identities, raw URLs, and tokens are never read or returned.
//
// Missing bindings, import rows, or telemetry surface as `null` (unknown),
// never `0`. Native sessions and API activity are not yet measurable in a
// grouped query and are reported as unknown with an honest note.

import {
  DAILY_ENGAGEMENT_SCHEMA,
  DailyEngagementReportV1,
  type DailyEngagementProductReportV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';

/** SaaS Maker centralized log events that map to engagement metrics. */
const FEEDBACK_EVENT = 'feedback.submitted';
const WAITLIST_EVENT = 'waitlist.join';
const NEWSLETTER_EVENT = 'newsletter.subscribe';

/** D1 binds a bounded number of parameters per statement; chunk to stay safe. */
const D1_IN_CHUNK = 90;
const DAY_MS = 86_400_000;
const INDIA_OFFSET_MS = 330 * 60_000;

export interface CatalogProductRow {
  catalog_id: string;
  app_id: string;
  catalog_name: string;
  environment_id: string | null;
  analytics_first_received_at: number | null;
}

interface BrowserVisitorRow {
  app_id: string;
  visitors: number;
  last_seen: number | null;
  sample_interval: number;
}

interface CtaEventRow {
  app_id: string;
  name: string;
  count: number;
  sample_interval: number;
}

export interface EngagementLogRow {
  app_id: string;
  event: string;
  project_id: string | null;
  project: string | null;
  type: string | null;
  kind: string | null;
  count: number;
  last_seen: number;
}

export interface DailyEngagementInputs {
  catalog: readonly CatalogProductRow[];
  browserVisitors: readonly BrowserVisitorRow[];
  ctaEvents: readonly CtaEventRow[];
  logs: readonly EngagementLogRow[];
  ctaEventNamesByCatalogId: Readonly<Record<string, readonly string[]>>;
  ctaNotApplicableCatalogIds?: readonly string[];
  confirmedLogMetricsByCatalogId?: Readonly<Record<string, readonly MetricKind[]>>;
  date: string;
  from: number;
  to: number;
  now: number;
  /** False when a grouped query failed; every product row reports that surface unknown. */
  browserMeasured: boolean;
  logsMeasured: boolean;
  notes?: string[];
}

type MetricKind = 'feedback' | 'waitlist' | 'newsletter';

function nonEmpty(value: string | null): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Resolve which engagement metric a centralized log row represents. */
function logMetricKind(row: EngagementLogRow): MetricKind | null {
  if (row.event === FEEDBACK_EVENT) return 'feedback';
  if (row.event === NEWSLETTER_EVENT) return 'newsletter';
  if (row.event === WAITLIST_EVENT) return 'waitlist';
  return null;
}

/** Map a centralized log row to a catalog_id, preferring explicit project props. */
function resolveCatalogId(
  row: EngagementLogRow,
  byCatalogId: Map<string, CatalogProductRow>,
  byAppId: Map<string, CatalogProductRow>,
): string | null {
  const projectId = nonEmpty(row.project_id);
  const project = nonEmpty(row.project);
  if (projectId && byCatalogId.has(projectId)) return projectId;
  if (project && byCatalogId.has(project)) return project;
  // A centralized submission with an unknown project must never be assigned
  // to the SaaS Maker app simply because its ingest key delivered the log.
  if (projectId || project) return null;
  const direct = byAppId.get(row.app_id);
  return direct ? direct.catalog_id : null;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface ReportIndexes {
  byCatalogId: Map<string, CatalogProductRow>;
  byAppId: Map<string, CatalogProductRow>;
  visitorsByApp: Map<string, BrowserVisitorRow>;
  browserLastSeen: Map<string, number>;
  ctaByApp: Map<string, Map<string, number>>;
  logCounts: Map<string, Partial<Record<MetricKind, number>>>;
  logLastSeen: Map<string, number>;
  unmappedLogs: number;
}

function indexReportInputs(input: DailyEngagementInputs): ReportIndexes {
  const byCatalogId = new Map(input.catalog.map((row) => [row.catalog_id, row]));
  const byAppId = new Map(input.catalog.map((row) => [row.app_id, row]));
  const visitorsByApp = new Map(input.browserVisitors.map((row) => [row.app_id, row]));
  const browserLastSeen = new Map<string, number>();
  input.browserVisitors.forEach((row) => {
    if (row.last_seen !== null) browserLastSeen.set(row.app_id, row.last_seen);
  });
  return {
    byCatalogId,
    byAppId,
    visitorsByApp,
    browserLastSeen,
    ctaByApp: indexCtaEvents(input.ctaEvents),
    ...indexLogEvents(input.logs, byCatalogId, byAppId),
  };
}

function indexCtaEvents(rows: readonly CtaEventRow[]): Map<string, Map<string, number>> {
  const byApp = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const events = byApp.get(row.app_id) ?? new Map<string, number>();
    events.set(row.name, (events.get(row.name) ?? 0) + row.count);
    byApp.set(row.app_id, events);
  }
  return byApp;
}

function indexLogEvents(
  rows: readonly EngagementLogRow[],
  byCatalogId: Map<string, CatalogProductRow>,
  byAppId: Map<string, CatalogProductRow>,
): Pick<ReportIndexes, 'logCounts' | 'logLastSeen' | 'unmappedLogs'> {
  const logCounts = new Map<string, Partial<Record<MetricKind, number>>>();
  const logLastSeen = new Map<string, number>();
  let unmappedLogs = 0;
  for (const row of rows) {
    const catalogId = resolveCatalogId(row, byCatalogId, byAppId);
    if (!catalogId) {
      unmappedLogs += 1;
      continue;
    }
    const kind = logMetricKind(row);
    if (!kind) continue;
    addLogCount(logCounts, catalogId, kind, row.count);
    logLastSeen.set(catalogId, Math.max(logLastSeen.get(catalogId) ?? 0, row.last_seen));
  }
  return { logCounts, logLastSeen, unmappedLogs };
}

function addLogCount(
  countsByProduct: Map<string, Partial<Record<MetricKind, number>>>,
  catalogId: string,
  kind: MetricKind,
  count: number,
): void {
  const counts = countsByProduct.get(catalogId) ?? {};
  counts[kind] = (counts[kind] ?? 0) + count;
  countsByProduct.set(catalogId, counts);
}

function isSampled(input: DailyEngagementInputs): boolean {
  return [...input.browserVisitors, ...input.ctaEvents].some((row) => row.sample_interval > 1);
}

function reportNotes(
  input: DailyEngagementInputs,
  sampled: boolean,
  unmappedLogs: number,
): string[] {
  const notes = [
    ...(input.notes ?? []),
    'native_sessions and api_activity are not yet measurable in a grouped query and are reported as unknown.',
  ];
  if (input.catalog.length !== 55)
    notes.push(
      `Only ${input.catalog.length} catalog product(s) are imported; 55 active Fleet products are expected. Missing products are outside this report.`,
    );
  if (Object.keys(input.ctaEventNamesByCatalogId).length === 0)
    notes.push(
      `No qualified primary CTA events are reportable for ${input.date}; counts are unknown.`,
    );
  if (unmappedLogs > 0)
    notes.push(
      `${unmappedLogs} centralized log group(s) could not be mapped to a declared catalog product and were excluded.`,
    );
  if (!input.browserMeasured)
    notes.push(
      'Browser Analytics Engine query was unavailable; browser visitors and CTA events are unknown.',
    );
  if (!input.logsMeasured)
    notes.push('D1 log_events query was unavailable; feedback and join counts are unknown.');
  if (sampled)
    notes.push(
      'Sampled browser visitor groups are unknown because distinct visitors cannot be scaled.',
    );
  return notes;
}

function metricCount(
  kind: MetricKind,
  input: DailyEngagementInputs,
  row: CatalogProductRow,
  counts: Partial<Record<MetricKind, number>> | undefined,
): number | null {
  const confirmed = input.confirmedLogMetricsByCatalogId?.[row.catalog_id] ?? [];
  return input.logsMeasured && (counts?.[kind] !== undefined || confirmed.includes(kind))
    ? (counts?.[kind] ?? 0)
    : null;
}

function buildProductReport(
  row: CatalogProductRow,
  input: DailyEngagementInputs,
  indexes: ReportIndexes,
): DailyEngagementProductReportV1 {
  const visitor = indexes.visitorsByApp.get(row.app_id);
  const browserMeasured = isProductBrowserMeasured(row, visitor, input);
  const ctas = productCtas(row, input, indexes.ctaByApp, browserMeasured);
  const logCounts = indexes.logCounts.get(row.catalog_id);
  const feedback = metricCount('feedback', input, row, logCounts);
  const newsletter = metricCount('newsletter', input, row, logCounts);
  const waitlist = metricCount('waitlist', input, row, logCounts);
  const logsMeasured = [feedback, newsletter, waitlist].some((count) => count !== null);
  const measured = Number(browserMeasured) + Number(logsMeasured);
  return {
    catalog_id: row.catalog_id,
    app_id: row.app_id,
    name: row.catalog_name,
    browser_visitors: browserMeasured ? Math.max(0, Math.round(visitor?.visitors ?? 0)) : null,
    cta_events: ctas,
    cta_status: input.ctaNotApplicableCatalogIds?.includes(row.catalog_id)
      ? 'not_applicable'
      : ctas.length > 0
        ? 'measured'
        : 'unknown',
    feedback_submitted: feedback,
    newsletter_joins: newsletter,
    waitlist_joins: waitlist,
    native_sessions: null,
    api_activity: null,
    freshness: {
      browser_last_seen: indexes.browserLastSeen.get(row.app_id) ?? null,
      log_last_seen: indexes.logLastSeen.get(row.catalog_id) ?? null,
    },
    coverage: measured === 0 ? 'unknown' : 'partial',
  };
}

function isProductBrowserMeasured(
  row: CatalogProductRow,
  visitor: BrowserVisitorRow | undefined,
  input: DailyEngagementInputs,
): boolean {
  return (
    input.browserMeasured &&
    row.environment_id !== null &&
    (visitor !== undefined ||
      (row.analytics_first_received_at !== null && row.analytics_first_received_at < input.to)) &&
    (visitor === undefined || visitor.sample_interval <= 1)
  );
}

function productCtas(
  row: CatalogProductRow,
  input: DailyEngagementInputs,
  ctaByApp: Map<string, Map<string, number>>,
  browserMeasured: boolean,
): DailyEngagementProductReportV1['cta_events'] {
  const configured = input.ctaEventNamesByCatalogId[row.catalog_id] ?? [];
  if (!browserMeasured || configured.length === 0) return [];
  return configured.slice(0, 3).map((name) => ({
    name,
    count: Math.max(0, Math.round(ctaByApp.get(row.app_id)?.get(name) ?? 0)),
  }));
}

/**
 * Pure report builder. Aggregates grouped query results onto the declared
 * catalog scope, maps centralized SaaS Maker logs to products, and reports
 * unknown (null) for any unmeasured surface. Fully testable without D1/AE.
 */
export const buildDailyEngagementReport = (
  input: DailyEngagementInputs,
): DailyEngagementReportV1 => {
  const indexes = indexReportInputs(input);
  const sampled = isSampled(input);
  const notes = reportNotes(input, sampled, indexes.unmappedLogs);
  const products: DailyEngagementProductReportV1[] = [];
  for (const row of input.catalog) products.push(buildProductReport(row, input, indexes));

  const report = {
    schema: DAILY_ENGAGEMENT_SCHEMA,
    schema_version: 1 as const,
    generated_at: input.now,
    date: input.date,
    timezone: 'Asia/Kolkata' as const,
    from: input.from,
    to: input.to,
    product_count: products.length,
    products,
    sampled,
    notes,
  };
  return DailyEngagementReportV1.parse(report);
};

type DailyEngagementWindow = { date: string; from: number; to: number } | { error: string };

/** India calendar-day bounds. Defaults to the latest completed day. */
export function dailyEngagementWindow(date: string | null, now: number): DailyEngagementWindow {
  const reference = Math.floor(now);
  const todayStart = Math.floor((reference + INDIA_OFFSET_MS) / DAY_MS) * DAY_MS - INDIA_OFFSET_MS;
  let dayStart: number;
  let dateLabel: string;
  if (date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return { error: 'date must be YYYY-MM-DD' };
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    )
      return { error: 'date must be a real calendar day' };
    dayStart = parsed.getTime() - INDIA_OFFSET_MS;
    dateLabel = date;
  } else {
    dayStart = todayStart - DAY_MS;
    dateLabel = new Date(dayStart + INDIA_OFFSET_MS).toISOString().slice(0, 10);
  }
  if (dayStart >= todayStart) return { error: 'date must be a completed Asia/Kolkata day' };
  return { date: dateLabel, from: dayStart, to: dayStart + DAY_MS };
}

/** Read the declared catalog scope for a workspace (grouped, bounded). */
async function readDailyEngagementCatalog(
  db: D1DatabaseLike,
  workspaceId: string,
): Promise<CatalogProductRow[]> {
  const result = await db
    .prepare(
      `SELECT c.catalog_id, c.app_id, c.catalog_name, e.id AS environment_id,
         ac.first_received_at AS analytics_first_received_at
       FROM catalog_project_imports c
       LEFT JOIN environments e ON e.app_id = c.app_id AND lower(e.name) = 'production'
       LEFT JOIN environment_capabilities ac ON ac.app_id = c.app_id
         AND ac.environment_id = e.id AND ac.capability = 'analytics'
       WHERE c.workspace_id = ? AND c.lifecycle IN ('primary', 'active')
       ORDER BY c.catalog_id`,
    )
    .bind(workspaceId)
    .all<CatalogProductRow>();
  return result.results;
}

/** Grouped D1 log_events query for feedback / waitlist / newsletter joins. */
export async function readDailyEngagementLogs(
  db: D1DatabaseLike,
  appIds: readonly string[],
  from: number,
  to: number,
): Promise<EngagementLogRow[]> {
  if (appIds.length === 0) return [];
  const rows: EngagementLogRow[] = [];
  for (let offset = 0; offset < appIds.length; offset += D1_IN_CHUNK) {
    const chunk = appIds.slice(offset, offset + D1_IN_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const result = await db
      .prepare(
        `SELECT log_events.app_id AS app_id,
          json_extract(props, '$.project_id') AS project_id,
          json_extract(props, '$.project') AS project,
          json_extract(props, '$.type') AS type,
          json_extract(props, '$.kind') AS kind,
          event,
          COUNT(*) AS count,
          MAX(timestamp) AS last_seen
        FROM log_events
        JOIN environments e ON e.id = log_events.environment_id
          AND e.app_id = log_events.app_id AND lower(e.name) = 'production'
        WHERE event IN ('${FEEDBACK_EVENT}', '${WAITLIST_EVENT}', '${NEWSLETTER_EVENT}')
          AND timestamp >= ? AND timestamp < ?
          AND log_events.app_id IN (${placeholders})
        GROUP BY log_events.app_id, project_id, project, type, kind, event`,
      )
      .bind(from, to, ...chunk)
      .all<EngagementLogRow>();
    for (const row of result.results) {
      rows.push({
        app_id: String(row.app_id),
        event: String(row.event),
        project_id: nonEmpty(typeof row.project_id === 'string' ? row.project_id : null),
        project: nonEmpty(typeof row.project === 'string' ? row.project : null),
        type: nonEmpty(typeof row.type === 'string' ? row.type : null),
        kind: nonEmpty(typeof row.kind === 'string' ? row.kind : null),
        count: Math.max(0, Math.round(Number(row.count))),
        last_seen: Math.max(0, Math.round(Number(row.last_seen))),
      });
    }
  }
  return rows;
}

export interface AnalyticsEngineQuery {
  (sql: string): Promise<unknown[]>;
}

interface BrowserVisitorQueryRow {
  app_id: string;
  visitors: number | string;
  last_seen: number | string | null;
  sample_interval: number | string;
}
interface CtaQueryRow {
  app_id: string;
  name: string;
  count: number | string;
  sample_interval: number | string;
}

const num = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('invalid analytical response');
  return n;
};

/** Grouped Analytics Engine query for browser visitors per app for one day. */
async function readDailyEngagementBrowser(
  workspace: string,
  catalog: readonly CatalogProductRow[],
  from: number,
  to: number,
  query: AnalyticsEngineQuery,
  ctaEventNames: readonly string[],
): Promise<{ visitors: BrowserVisitorRow[]; cta: CtaEventRow[]; measured: boolean }> {
  const appIds = catalog.map((row) => row.app_id);
  const environmentIds = catalog.flatMap((row) => (row.environment_id ? [row.environment_id] : []));
  if (appIds.length === 0 || environmentIds.length === 0)
    return { visitors: [], cta: [], measured: true };
  const scope = `blob1 IN (${appIds.map(sqlLiteral).join(',')})`;
  const environments = `blob2 IN (${environmentIds.map(sqlLiteral).join(',')})`;
  const visitorSql = `SELECT blob1 AS app_id,
    COUNT(DISTINCT blob8) AS visitors,
    MAX(double2) AS last_seen,
    MAX(_sample_interval) AS sample_interval
    FROM app_health_browser_v1
    WHERE index1 = ${sqlLiteral(workspace)} AND double2 >= ${from} AND double2 < ${to}
    AND ${scope} AND ${environments} AND blob8 != ''
    GROUP BY blob1 LIMIT 1000`;
  const ctaNames = ctaEventNames.map(sqlLiteral).join(',');
  const ctaSql = `SELECT blob1 AS app_id, blob5 AS name,
    SUM(_sample_interval) AS count, MAX(_sample_interval) AS sample_interval
    FROM app_health_browser_v1
    WHERE index1 = ${sqlLiteral(workspace)} AND double2 >= ${from} AND double2 < ${to}
    AND blob3 = 'event' AND blob8 != '' AND blob5 IN (${ctaNames})
    AND ${scope} AND ${environments}
    GROUP BY blob1, blob5 LIMIT 1000`;
  try {
    const [visitorRows, ctaRows] = await Promise.all([
      query(visitorSql) as Promise<unknown[]>,
      ctaEventNames.length > 0 ? (query(ctaSql) as Promise<unknown[]>) : Promise.resolve([]),
    ]);
    const visitors: BrowserVisitorRow[] = (visitorRows as BrowserVisitorQueryRow[]).map((row) => ({
      app_id: String(row.app_id),
      visitors: Math.max(0, Math.round(num(row.visitors))),
      last_seen:
        row.last_seen === null || row.last_seen === undefined
          ? null
          : Math.round(num(row.last_seen)),
      sample_interval: Math.max(1, Math.round(num(row.sample_interval))),
    }));
    const cta: CtaEventRow[] = (ctaRows as CtaQueryRow[]).map((row) => ({
      app_id: String(row.app_id),
      name: String(row.name),
      count: Math.max(0, Math.round(num(row.count))),
      sample_interval: Math.max(1, Math.round(num(row.sample_interval))),
    }));
    return { visitors, cta, measured: true };
  } catch {
    return { visitors: [], cta: [], measured: false };
  }
}

/** Compose the full report by reading catalog, browser, and log aggregates. */
export async function composeDailyEngagementReport(args: {
  db: D1DatabaseLike;
  workspaceId: string;
  query?: AnalyticsEngineQuery;
  date: string | null;
  now: number;
  ctaEventNamesByCatalogId?: Readonly<Record<string, readonly string[]>>;
  ctaNotApplicableCatalogIds?: readonly string[];
  confirmedLogMetricsByCatalogId?: Readonly<Record<string, readonly MetricKind[]>>;
}): Promise<DailyEngagementReportV1> {
  const window = dailyEngagementWindow(args.date, args.now);
  if ('error' in window) throw Object.assign(new Error(window.error), { status: 400 });
  const catalog = await readDailyEngagementCatalog(args.db, args.workspaceId);
  const appIds = catalog.map((row) => row.app_id);
  const ctaEventNamesByCatalogId = args.ctaEventNamesByCatalogId ?? {};
  const ctaEventNames = [...new Set(Object.values(ctaEventNamesByCatalogId).flat())];
  const [browser, logResult] = await Promise.all([
    args.query
      ? readDailyEngagementBrowser(
          args.workspaceId,
          catalog,
          window.from,
          window.to,
          args.query,
          ctaEventNames,
        )
      : Promise.resolve({ visitors: [], cta: [], measured: false }),
    readDailyEngagementLogs(args.db, appIds, window.from, window.to)
      .then((rows) => ({ rows, measured: true }))
      .catch(() => ({ rows: [] as EngagementLogRow[], measured: false })),
  ]);
  return buildDailyEngagementReport({
    catalog,
    browserVisitors: browser.visitors,
    ctaEvents: browser.cta,
    logs: logResult.rows,
    ctaEventNamesByCatalogId,
    ctaNotApplicableCatalogIds: args.ctaNotApplicableCatalogIds,
    confirmedLogMetricsByCatalogId: args.confirmedLogMetricsByCatalogId,
    date: window.date,
    from: window.from,
    to: window.to,
    now: args.now,
    browserMeasured: browser.measured,
    logsMeasured: logResult.measured,
  });
}
