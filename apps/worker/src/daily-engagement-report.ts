// Bounded owner-only daily engagement report across the workspace's declared
// catalog products. Reports one completed Asia/Kolkata day using grouped Analytics
// Engine queries (browser visitors + CTA events) and a grouped D1 log_events
// query (feedback / waitlist / newsletter joins). SaaS Maker source aggregates
// are preferred when covered; positive log counts remain lower bounds otherwise.
// No per-app query loops.
//
// Privacy: only counts, canonical IDs, and freshness timestamps leave this
// module. Centralized SaaS Maker log props (project_id/project/type/kind) are
// resolved to a catalog_id and discarded; submitted content, email, headers,
// cookies, identities, raw URLs, and tokens are never read or returned.
//
// Missing bindings, import rows, or telemetry surface as `null` (unknown),
// never `0`. Native sessions use a separately isolated, best-effort Analytics
// Engine projection; absent or sampled rows remain unknown. API activity counts only durable, unsampled accepted endpoint aggregates.

import {
  DAILY_ENGAGEMENT_SCHEMA,
  DailyEngagementReportV1,
  ReportDate,
  type DailyEngagementProductReportV1,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import { endpointReadRanges } from './endpoint-read.js';

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
  unique_browsers: number;
  sample_interval: number;
}

interface NativeSessionRow {
  app_id: string;
  sessions: number;
  sample_interval: number;
}

interface ApiActivityRow {
  app_id: string;
  request_count: number;
  upstream_sampled: number;
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

interface DailyCaptureCountRow {
  catalogId: string;
  feedback: number | null;
  newsletter: number | null;
  waitlist: number | null;
}

interface DailyCaptureCounts {
  coverageStart: string | null;
  rows: readonly DailyCaptureCountRow[];
  /** Catalog policy returned by SaaS Maker; absent on older compatible providers. */
  applicabilityByCatalogId?: Readonly<Record<string, CaptureApplicability>>;
  nativeSessionsApplicabilityByCatalogId?: Readonly<Record<string, MetricApplicability>>;
  browserVisitorsApplicabilityByCatalogId?: Readonly<Record<string, MetricApplicability>>;
  serverRequestsApplicabilityByCatalogId?: Readonly<Record<string, MetricApplicability>>;
}

export interface DailyCaptureCountsService {
  getDailyCaptureCounts(input: { date: string; catalogIds: string[] }): Promise<DailyCaptureCounts>;
}

export interface DailyEngagementInputs {
  catalog: readonly CatalogProductRow[];
  browserVisitors: readonly BrowserVisitorRow[];
  ctaEvents: readonly CtaEventRow[];
  nativeSessions?: readonly NativeSessionRow[];
  apiActivity?: readonly ApiActivityRow[];
  logs: readonly EngagementLogRow[];
  ctaEventNamesByCatalogId: Readonly<Record<string, readonly string[]>>;
  ctaNotApplicableCatalogIds?: readonly string[];
  confirmedLogMetricsByCatalogId?: Readonly<Record<string, readonly MetricKind[]>>;
  date: string;
  from: number;
  to: number;
  now: number;
  /** False when the browser visitor query failed; visitor counts are unknown. */
  browserMeasured: boolean;
  /** False when the CTA query failed; CTA counts are unknown. Defaults to browserMeasured. */
  ctaMeasured?: boolean;
  /** False when the native session query failed; missing rows remain unknown. */
  nativeSessionsMeasured?: boolean;
  /** False when durable endpoint rollups could not be queried. */
  apiActivityMeasured?: boolean;
  logsMeasured: boolean;
  /** SaaS Maker source counts are exact only on or after coverageStart. */
  captureCounts?: DailyCaptureCounts;
  captureCountsAvailable?: boolean;
  /** True when the source service was configured and queried, even if it failed. */
  captureCountsRequested?: boolean;
  notes?: string[];
}

type MetricKind = 'feedback' | 'waitlist' | 'newsletter';
type CaptureApplicability = 'newsletter' | 'waitlist' | 'not-applicable' | 'undetermined';
type MetricApplicability = 'applicable' | 'not_applicable' | 'unknown';

function validateDailyCaptureCounts(
  value: unknown,
  catalogIds: readonly string[],
): DailyCaptureCounts {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid SaaS Maker aggregate response');
  const response = value as Record<string, unknown>;
  const coverageStart = response.coverageStart;
  if (
    coverageStart !== null &&
    (typeof coverageStart !== 'string' || !ReportDate.safeParse(coverageStart).success)
  )
    throw new Error('invalid SaaS Maker aggregate coverage');
  if (!Array.isArray(response.rows) || response.rows.length > catalogIds.length)
    throw new Error('invalid SaaS Maker aggregate rows');
  const allowedIds = new Set(catalogIds);
  const seenIds = new Set<string>();
  const rows = response.rows.map((value): DailyCaptureCountRow => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('invalid SaaS Maker aggregate row');
    const row = value as Record<string, unknown>;
    if (
      typeof row.catalogId !== 'string' ||
      !allowedIds.has(row.catalogId) ||
      seenIds.has(row.catalogId)
    )
      throw new Error('invalid SaaS Maker aggregate catalog mapping');
    seenIds.add(row.catalogId);
    const count = (kind: MetricKind): number | null => {
      const result = row[kind];
      if (
        result !== null &&
        (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0)
      )
        throw new Error('invalid SaaS Maker aggregate count');
      return result;
    };
    return {
      catalogId: row.catalogId,
      feedback: count('feedback'),
      newsletter: count('newsletter'),
      waitlist: count('waitlist'),
    };
  });
  const applicabilityByCatalogId = parseCaptureApplicability(
    response.applicabilityByCatalogId,
    allowedIds,
  );
  const nativeSessionsApplicabilityByCatalogId = parseMetricApplicability(
    response.nativeSessionsApplicabilityByCatalogId,
    allowedIds,
  );
  const browserVisitorsApplicabilityByCatalogId = parseMetricApplicability(
    response.browserVisitorsApplicabilityByCatalogId,
    allowedIds,
  );
  const serverRequestsApplicabilityByCatalogId = parseMetricApplicability(
    response.serverRequestsApplicabilityByCatalogId,
    allowedIds,
  );
  return {
    coverageStart: coverageStart as string | null,
    rows,
    applicabilityByCatalogId,
    nativeSessionsApplicabilityByCatalogId,
    browserVisitorsApplicabilityByCatalogId,
    serverRequestsApplicabilityByCatalogId,
  };
}

function parseMetricApplicability(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): Record<string, MetricApplicability> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid SaaS Maker metric applicability');
  const policy: Record<string, MetricApplicability> = {};
  for (const [catalogId, applicability] of Object.entries(value)) {
    if (
      !allowedIds.has(catalogId) ||
      !['applicable', 'not_applicable', 'unknown'].includes(String(applicability))
    )
      throw new Error('invalid SaaS Maker metric applicability');
    policy[catalogId] = applicability as MetricApplicability;
  }
  return policy;
}

function parseCaptureApplicability(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): Record<string, CaptureApplicability> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid SaaS Maker capture applicability');
  const policy: Record<string, CaptureApplicability> = {};
  for (const [catalogId, applicability] of Object.entries(value)) {
    if (
      !allowedIds.has(catalogId) ||
      !['newsletter', 'waitlist', 'not-applicable', 'undetermined'].includes(String(applicability))
    )
      throw new Error('invalid SaaS Maker capture applicability');
    policy[catalogId] = applicability as CaptureApplicability;
  }
  return policy;
}

function metricApplicability(
  capture: CaptureApplicability | undefined,
  metric: 'newsletter' | 'waitlist',
): MetricApplicability {
  if (!capture || capture === 'undetermined') return 'unknown';
  if (capture === metric) return 'applicable';
  return 'not_applicable';
}

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
  nativeSessionsByApp: Map<string, NativeSessionRow>;
  apiActivityByApp: Map<string, ApiActivityRow>;
  browserLastSeen: Map<string, number>;
  ctaByApp: Map<
    string,
    Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>
  >;
  logCounts: Map<string, Partial<Record<MetricKind, number>>>;
  logLastSeen: Map<string, number>;
  unmappedLogs: number;
}

function indexReportInputs(input: DailyEngagementInputs): ReportIndexes {
  const byCatalogId = new Map(input.catalog.map((row) => [row.catalog_id, row]));
  const byAppId = new Map(input.catalog.map((row) => [row.app_id, row]));
  const visitorsByApp = new Map(input.browserVisitors.map((row) => [row.app_id, row]));
  const nativeSessionsByApp = new Map((input.nativeSessions ?? []).map((row) => [row.app_id, row]));
  const apiActivityByApp = new Map((input.apiActivity ?? []).map((row) => [row.app_id, row]));
  const browserLastSeen = new Map<string, number>();
  input.browserVisitors.forEach((row) => {
    if (row.last_seen !== null) browserLastSeen.set(row.app_id, row.last_seen);
  });
  return {
    byCatalogId,
    byAppId,
    visitorsByApp,
    nativeSessionsByApp,
    apiActivityByApp,
    browserLastSeen,
    ctaByApp: indexCtaEvents(input.ctaEvents),
    ...indexLogEvents(input.logs, byCatalogId, byAppId),
  };
}

function indexCtaEvents(
  rows: readonly CtaEventRow[],
): Map<string, Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>> {
  const byApp = new Map<
    string,
    Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>
  >();
  for (const row of rows) {
    const events =
      byApp.get(row.app_id) ??
      new Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>();
    const previous = events.get(row.name);
    events.set(row.name, {
      count: (previous?.count ?? 0) + row.count,
      // Distinct counts from duplicate groups cannot be added without overlap data.
      unique_browsers: previous || row.sample_interval > 1 ? null : row.unique_browsers,
      estimated: (previous?.estimated ?? false) || row.sample_interval > 1,
    });
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
  return [...input.browserVisitors, ...input.ctaEvents, ...(input.nativeSessions ?? [])].some(
    (row) => row.sample_interval > 1,
  );
}

function analyticsAvailabilityNote(input: DailyEngagementInputs): string | null {
  const ctaMeasured = input.ctaMeasured ?? input.browserMeasured;
  if (!input.browserMeasured && !ctaMeasured)
    return 'Browser Analytics Engine query was unavailable; browser visitors and CTA events are unknown.';
  if (!input.browserMeasured)
    return 'Browser visitor Analytics Engine query was unavailable; browser visitors are unknown.';
  if (!ctaMeasured)
    return 'CTA Analytics Engine query was unavailable; CTA event counts are unknown.';
  return null;
}

function samplingNotes(input: DailyEngagementInputs): string[] {
  const notes: string[] = [];
  if (input.browserVisitors.some((row) => row.sample_interval > 1))
    notes.push(
      'Sampled browser visitor groups are unknown because distinct visitors cannot be scaled.',
    );
  if (input.ctaEvents.some((row) => row.sample_interval > 1))
    notes.push(
      'Sampled CTA query days omit unobserved actions; scaled counts are labeled approximate.',
    );
  if (input.apiActivityMeasured === false)
    notes.push('Durable endpoint rollup query was unavailable; server request counts are unknown.');
  if (input.apiActivity?.some((row) => row.upstream_sampled > 0))
    notes.push(
      'Sampled endpoint groups are unknown; only unsampled accepted server requests are counted.',
    );
  if (input.nativeSessionsMeasured === false)
    notes.push(
      'Native session Analytics Engine query was unavailable; native sessions are unknown.',
    );
  if ((input.nativeSessions ?? []).some((row) => row.sample_interval > 1))
    notes.push(
      'Sampled native session groups are unknown because distinct sessions cannot be scaled.',
    );
  return notes;
}

function reportNotes(input: DailyEngagementInputs, unmappedLogs: number): string[] {
  const notes = [
    ...(input.notes ?? []),
    'Native sessions count only observed, unsampled native heartbeats; missing or sampled rows are unknown. Server requests count accepted durable endpoint aggregates and do not represent people. Browser visitors count recognized browsers, not people.',
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
  const analyticsNote = analyticsAvailabilityNote(input);
  if (analyticsNote) notes.push(analyticsNote);
  if (!input.logsMeasured)
    notes.push('D1 log_events query was unavailable; feedback and join counts are unknown.');
  notes.push(
    'Feedback and join counts cover SaaS Maker hosted submissions and observed App Health events only; feedback from other native or API sources is unknown.',
  );
  notes.push(...captureApplicabilityNotes(input));
  const captureCoverage =
    input.captureCounts?.coverageStart !== null && input.captureCounts?.coverageStart !== undefined;
  if (!input.captureCountsAvailable) {
    notes.push(
      'SaaS Maker source counts were unavailable; positive App Health log counts are lower bounds, and absent counts remain unknown.',
    );
  } else if (!captureCoverage || input.date < input.captureCounts!.coverageStart!) {
    notes.push(
      'SaaS Maker source counts do not cover this date; positive App Health log counts are lower bounds, and absent counts remain unknown.',
    );
  } else if (
    input.catalog.some((row) => {
      const source = input.captureCounts?.rows.find((item) => item.catalogId === row.catalog_id);
      return (
        !source ||
        source.feedback === null ||
        source.newsletter === null ||
        source.waitlist === null
      );
    })
  ) {
    notes.push(
      'SaaS Maker source counts are unavailable for one or more product metrics; positive App Health log counts are lower bounds.',
    );
  }
  notes.push(...samplingNotes(input));
  return notes;
}

function captureApplicabilityNotes(input: DailyEngagementInputs): string[] {
  return Object.keys(input.captureCounts?.applicabilityByCatalogId ?? {}).length > 0
    ? [
        'Newsletter and waitlist applicability follows canonical capture policy; Not applicable is not a measured zero, and observed positive counts remain visible.',
      ]
    : [];
}

function coveredCaptureCount(
  kind: MetricKind,
  input: DailyEngagementInputs,
  row: CatalogProductRow,
): number | null {
  if (!input.captureCountsAvailable) return null;
  const coverageStart = input.captureCounts?.coverageStart;
  if (!coverageStart || input.date < coverageStart) return null;
  return (
    input.captureCounts?.rows.find((item) => item.catalogId === row.catalog_id)?.[kind] ?? null
  );
}

function metricCount(
  kind: MetricKind,
  input: DailyEngagementInputs,
  row: CatalogProductRow,
  counts: Partial<Record<MetricKind, number>> | undefined,
): number | null {
  const sourceCount = coveredCaptureCount(kind, input, row);
  if (sourceCount !== null) return sourceCount;

  // App Health log delivery is asynchronous, so a positive count is an observed
  // lower bound when the source aggregate is unavailable or does not cover it.
  const observedLogCount = input.logsMeasured ? counts?.[kind] : undefined;
  if (observedLogCount !== undefined && observedLogCount > 0) return observedLogCount;

  // A confirmed hook can establish zero only when the log source itself is the
  // authoritative measured surface. Never use that inference for fallback.
  if (input.captureCountsRequested || !input.logsMeasured) return null;
  const confirmed = input.confirmedLogMetricsByCatalogId?.[row.catalog_id] ?? [];
  return confirmed.includes(kind) ? (counts?.[kind] ?? 0) : null;
}

function buildProductReport(
  row: CatalogProductRow,
  input: DailyEngagementInputs,
  indexes: ReportIndexes,
): DailyEngagementProductReportV1 {
  const visitor = indexes.visitorsByApp.get(row.app_id);
  const nativeSession = indexes.nativeSessionsByApp.get(row.app_id);
  const browserMeasured = isProductBrowserMeasured(row, visitor, input);
  const ctaMeasured = isProductCtaMeasured(row, visitor, input, indexes.ctaByApp);
  const ctas = productCtas(row, input, visitor, indexes.ctaByApp, ctaMeasured);
  const logCounts = indexes.logCounts.get(row.catalog_id);
  const feedback = metricCount('feedback', input, row, logCounts);
  const newsletter = metricCount('newsletter', input, row, logCounts);
  const waitlist = metricCount('waitlist', input, row, logCounts);
  const logsMeasured = [feedback, newsletter, waitlist].some((count) => count !== null);
  const nativeSessions =
    input.nativeSessionsMeasured && nativeSession && nativeSession.sample_interval <= 1
      ? nativeSession.sessions
      : null;
  const apiActivity = productApiActivity(row, input, indexes);
  const measured =
    Number(browserMeasured) +
    Number(ctas.length > 0) +
    Number(logsMeasured) +
    Number(nativeSessions !== null) +
    Number(apiActivity !== null);
  return {
    catalog_id: row.catalog_id,
    app_id: row.app_id,
    name: row.catalog_name,
    browser_visitors: browserMeasured ? Math.max(0, Math.round(visitor?.visitors ?? 0)) : null,
    browser_visitors_applicability: browserVisitorApplicability(input, row.catalog_id),
    cta_events: ctas,
    cta_status: input.ctaNotApplicableCatalogIds?.includes(row.catalog_id)
      ? 'not_applicable'
      : ctas.length > 0
        ? 'measured'
        : 'unknown',
    feedback_submitted: feedback,
    newsletter_joins: newsletter,
    newsletter_applicability: metricApplicability(
      input.captureCounts?.applicabilityByCatalogId?.[row.catalog_id],
      'newsletter',
    ),
    waitlist_joins: waitlist,
    waitlist_applicability: metricApplicability(
      input.captureCounts?.applicabilityByCatalogId?.[row.catalog_id],
      'waitlist',
    ),
    native_sessions: nativeSessions,
    native_sessions_applicability: nativeSessionApplicability(input, row.catalog_id),
    api_activity: apiActivity,
    server_requests_applicability: serverRequestApplicability(input, row.catalog_id),
    freshness: {
      browser_last_seen: indexes.browserLastSeen.get(row.app_id) ?? null,
      log_last_seen: indexes.logLastSeen.get(row.catalog_id) ?? null,
    },
    coverage: measured === 0 ? 'unknown' : 'partial',
  };
}

function nativeSessionApplicability(
  input: DailyEngagementInputs,
  catalogId: string,
): MetricApplicability {
  return input.captureCounts?.nativeSessionsApplicabilityByCatalogId?.[catalogId] ?? 'unknown';
}

function browserVisitorApplicability(
  input: DailyEngagementInputs,
  catalogId: string,
): MetricApplicability {
  return input.captureCounts?.browserVisitorsApplicabilityByCatalogId?.[catalogId] ?? 'unknown';
}

function serverRequestApplicability(
  input: DailyEngagementInputs,
  catalogId: string,
): MetricApplicability {
  return input.captureCounts?.serverRequestsApplicabilityByCatalogId?.[catalogId] ?? 'unknown';
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

function isProductCtaMeasured(
  row: CatalogProductRow,
  visitor: BrowserVisitorRow | undefined,
  input: DailyEngagementInputs,
  ctaByApp: Map<
    string,
    Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>
  >,
): boolean {
  return (
    (input.ctaEventNamesByCatalogId[row.catalog_id]?.length ?? 0) > 0 &&
    (input.ctaMeasured ?? input.browserMeasured) &&
    row.environment_id !== null &&
    (visitor !== undefined ||
      ctaByApp.has(row.app_id) ||
      (row.analytics_first_received_at !== null && row.analytics_first_received_at < input.to))
  );
}

function productCtas(
  row: CatalogProductRow,
  input: DailyEngagementInputs,
  visitor: BrowserVisitorRow | undefined,
  ctaByApp: Map<
    string,
    Map<string, { count: number; unique_browsers: number | null; estimated: boolean }>
  >,
  browserMeasured: boolean,
): DailyEngagementProductReportV1['cta_events'] {
  const configured = input.ctaEventNamesByCatalogId[row.catalog_id] ?? [];
  if (!browserMeasured || configured.length === 0) return [];
  const observed = ctaByApp.get(row.app_id);
  const querySampled = input.ctaEvents.some((event) => event.sample_interval > 1);
  if (querySampled) {
    return configured
      .filter((name) => observed?.has(name))
      .slice(0, 3)
      .map((name) => {
        const event = observed!.get(name)!;
        return {
          name,
          count: Math.max(0, Math.round(event.count)),
          unique_browsers: event.unique_browsers,
          estimated: event.estimated,
        };
      });
  }
  if (visitor !== undefined && visitor.sample_interval > 1 && !observed?.size) return [];
  return configured.slice(0, 3).map((name) => {
    const event = observed?.get(name);
    return {
      name,
      count: Math.max(0, Math.round(event?.count ?? 0)),
      unique_browsers: event?.unique_browsers ?? 0,
      estimated: event?.estimated ?? false,
    };
  });
}

function productApiActivity(
  row: CatalogProductRow,
  input: DailyEngagementInputs,
  indexes: ReportIndexes,
): number | null {
  if (!input.apiActivityMeasured || row.environment_id === null) return null;
  const activity = indexes.apiActivityByApp.get(row.app_id);
  return activity && activity.request_count > 0 && activity.upstream_sampled === 0
    ? activity.request_count
    : null;
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
  const notes = reportNotes(input, indexes.unmappedLogs);
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

/** Keep reports readable in already-open clients with the original strict row schema. */
export function dailyEngagementClientPayload(
  report: DailyEngagementReportV1,
  includeCaptureApplicability: boolean,
) {
  if (includeCaptureApplicability) return report;
  return {
    ...report,
    products: report.products.map((row) => {
      const legacyRow: Partial<DailyEngagementProductReportV1> = { ...row };
      delete legacyRow.newsletter_applicability;
      delete legacyRow.waitlist_applicability;
      delete legacyRow.native_sessions_applicability;
      delete legacyRow.browser_visitors_applicability;
      delete legacyRow.server_requests_applicability;
      return legacyRow;
    }),
  };
}

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

/** One workspace-scoped grouped read of durable production endpoint rollups. */
export async function readDailyApiActivity(
  db: D1DatabaseLike,
  workspaceId: string,
  from: number,
  to: number,
  catalog: readonly CatalogProductRow[],
): Promise<ApiActivityRow[]> {
  if (catalog.length === 0) return [];
  const ranges = endpointReadRanges(from, to);
  const values: unknown[] = ranges.flatMap((range) => [range.resolution, range.from, range.to]);
  values.push(workspaceId);
  const rangeValues = ranges.map(
    (_, index) => `(?${index * 3 + 1}, ?${index * 3 + 2}, ?${index * 3 + 3})`,
  );
  const workspaceIndex = values.length;
  const result = await db
    .prepare(
      `WITH ranges(resolution_ms, range_from, range_to) AS (VALUES ${rangeValues.join(',')})
     SELECT r.app_id, SUM(r.request_count) AS request_count,
       MAX(r.upstream_sampled) AS upstream_sampled
     FROM endpoint_rollups r
     JOIN ranges q ON q.resolution_ms = r.resolution_ms
       AND r.bucket_start >= q.range_from AND r.bucket_start < q.range_to
     JOIN environments e ON e.id = r.environment_id AND e.app_id = r.app_id
       AND lower(e.name) = 'production'
     JOIN catalog_project_imports c ON c.app_id = r.app_id
       AND c.workspace_id = ?${workspaceIndex} AND c.lifecycle IN ('primary', 'active')
     GROUP BY r.app_id LIMIT 56`,
    )
    .bind(...values)
    .all<ApiActivityRow>();
  if (result.results.length > 55) throw new Error('Daily endpoint query exceeded row limit');
  const allowedApps = new Set(catalog.flatMap((row) => (row.environment_id ? [row.app_id] : [])));
  const seen = new Set<string>();
  return result.results.map((row) => {
    const count = Number(row.request_count);
    const sampled = Number(row.upstream_sampled);
    if (
      !allowedApps.has(row.app_id) ||
      seen.has(row.app_id) ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      (sampled !== 0 && sampled !== 1)
    )
      throw new Error('Invalid daily endpoint aggregate');
    seen.add(row.app_id);
    return { app_id: row.app_id, request_count: count, upstream_sampled: sampled };
  });
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
  unique_browsers: number | string;
  sample_interval: number | string;
}
interface NativeSessionQueryRow {
  app_id: string;
  sessions: number | string;
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
): Promise<{
  visitors: BrowserVisitorRow[];
  cta: CtaEventRow[];
  visitorsMeasured: boolean;
  ctaMeasured: boolean;
}> {
  const appIds = catalog.map((row) => row.app_id);
  const environmentIds = catalog.flatMap((row) => (row.environment_id ? [row.environment_id] : []));
  if (appIds.length === 0 || environmentIds.length === 0)
    return { visitors: [], cta: [], visitorsMeasured: true, ctaMeasured: true };
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
    SUM(_sample_interval) AS count, COUNT(DISTINCT blob8) AS unique_browsers,
    MAX(_sample_interval) AS sample_interval
    FROM app_health_browser_v1
    WHERE index1 = ${sqlLiteral(workspace)} AND double2 >= ${from} AND double2 < ${to}
    AND blob3 = 'event' AND blob8 != '' AND blob5 IN (${ctaNames})
    AND ${scope} AND ${environments}
    GROUP BY blob1, blob5 LIMIT 1000`;
  const parseVisitor = (rows: unknown[]): BrowserVisitorRow[] =>
    (rows as BrowserVisitorQueryRow[]).map((row) => ({
      app_id: String(row.app_id),
      visitors: Math.max(0, Math.round(num(row.visitors))),
      last_seen:
        row.last_seen === null || row.last_seen === undefined
          ? null
          : Math.round(num(row.last_seen)),
      sample_interval: Math.max(1, Math.round(num(row.sample_interval))),
    }));
  const parseCta = (rows: unknown[]): CtaEventRow[] =>
    (rows as CtaQueryRow[]).map((row) => ({
      app_id: String(row.app_id),
      name: String(row.name),
      count: Math.max(0, Math.round(num(row.count))),
      unique_browsers: Math.max(0, Math.round(num(row.unique_browsers))),
      sample_interval: Math.max(1, Math.round(num(row.sample_interval))),
    }));
  // Run the two queries independently so a CTA failure does not discard
  // a successful visitor query (and vice versa).
  const visitorPromise = Promise.resolve()
    .then(() => query(visitorSql))
    .then(parseVisitor)
    .catch(() => null);
  const ctaPromise =
    ctaEventNames.length > 0
      ? Promise.resolve()
          .then(() => query(ctaSql))
          .then(parseCta)
          .catch(() => null)
      : Promise.resolve([]);
  const [visitorRows, ctaRows] = await Promise.all([visitorPromise, ctaPromise]);
  return {
    visitors: visitorRows ?? [],
    cta: ctaRows ?? [],
    visitorsMeasured: visitorRows !== null,
    ctaMeasured: ctaRows !== null,
  };
}

/** Count only observed, unsampled native-session projection rows. */
async function readDailyEngagementNativeSessions(
  workspace: string,
  catalog: readonly CatalogProductRow[],
  from: number,
  to: number,
  query: AnalyticsEngineQuery,
): Promise<{ rows: NativeSessionRow[]; measured: boolean }> {
  const appIds = catalog.map((row) => row.app_id);
  const environmentIds = catalog.flatMap((row) => (row.environment_id ? [row.environment_id] : []));
  if (appIds.length === 0 || environmentIds.length === 0) return { rows: [], measured: true };
  const sql = `SELECT blob1 AS app_id,
    COUNT(DISTINCT blob20) AS sessions,
    MAX(_sample_interval) AS sample_interval
    FROM app_health_browser_v1
    WHERE index1 = ${sqlLiteral(workspace)} AND double2 >= ${from} AND double2 < ${to}
    AND blob3 = 'native_session' AND blob20 != ''
    AND blob1 IN (${appIds.map(sqlLiteral).join(',')})
    AND blob2 IN (${environmentIds.map(sqlLiteral).join(',')})
    GROUP BY blob1 LIMIT 1000`;
  try {
    const rows = (await query(sql)) as NativeSessionQueryRow[];
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('invalid native session rows');
    const allowedApps = new Set(appIds);
    const seen = new Set<string>();
    return {
      rows: rows.map((row) => {
        if (typeof row.app_id !== 'string' || !allowedApps.has(row.app_id) || seen.has(row.app_id))
          throw new Error('invalid native session app');
        seen.add(row.app_id);
        return {
          app_id: row.app_id,
          sessions: Math.max(0, Math.round(num(row.sessions))),
          sample_interval: Math.max(1, Math.round(num(row.sample_interval))),
        };
      }),
      measured: true,
    };
  } catch {
    return { rows: [], measured: false };
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
  captureCountsService?: DailyCaptureCountsService;
}): Promise<DailyEngagementReportV1> {
  const window = dailyEngagementWindow(args.date, args.now);
  if ('error' in window) throw Object.assign(new Error(window.error), { status: 400 });
  const catalog = await readDailyEngagementCatalog(args.db, args.workspaceId);
  const appIds = catalog.map((row) => row.app_id);
  const sourceCatalogIds = catalog.slice(0, 55).map((row) => row.catalog_id);
  const ctaEventNamesByCatalogId = args.ctaEventNamesByCatalogId ?? {};
  const ctaEventNames = [...new Set(Object.values(ctaEventNamesByCatalogId).flat())];
  const [browser, nativeSessions, apiActivity, logResult, captureResult] = await Promise.all([
    args.query
      ? readDailyEngagementBrowser(
          args.workspaceId,
          catalog,
          window.from,
          window.to,
          args.query,
          ctaEventNames,
        )
      : Promise.resolve({
          visitors: [],
          cta: [],
          visitorsMeasured: false,
          ctaMeasured: false,
        }),
    args.query
      ? readDailyEngagementNativeSessions(
          args.workspaceId,
          catalog,
          window.from,
          window.to,
          args.query,
        )
      : Promise.resolve({ rows: [] as NativeSessionRow[], measured: false }),
    readDailyApiActivity(args.db, args.workspaceId, window.from, window.to, catalog)
      .then((rows) => ({ rows, measured: true }))
      .catch(() => ({ rows: [] as ApiActivityRow[], measured: false })),
    readDailyEngagementLogs(args.db, appIds, window.from, window.to)
      .then((rows) => ({ rows, measured: true }))
      .catch(() => ({ rows: [] as EngagementLogRow[], measured: false })),
    args.captureCountsService
      ? args.captureCountsService
          .getDailyCaptureCounts({ date: window.date, catalogIds: sourceCatalogIds })
          .then((result) => ({
            result: validateDailyCaptureCounts(result, sourceCatalogIds),
            available: true,
          }))
          .catch(() => ({ result: undefined, available: false }))
      : Promise.resolve({ result: undefined, available: false }),
  ]);
  return buildDailyEngagementReport({
    catalog,
    browserVisitors: browser.visitors,
    ctaEvents: browser.cta,
    nativeSessions: nativeSessions.rows,
    apiActivity: apiActivity.rows,
    logs: logResult.rows,
    ctaEventNamesByCatalogId,
    ctaNotApplicableCatalogIds: args.ctaNotApplicableCatalogIds,
    confirmedLogMetricsByCatalogId: args.confirmedLogMetricsByCatalogId,
    date: window.date,
    from: window.from,
    to: window.to,
    now: args.now,
    browserMeasured: browser.visitorsMeasured,
    ctaMeasured: browser.ctaMeasured,
    nativeSessionsMeasured: nativeSessions.measured,
    apiActivityMeasured: apiActivity.measured,
    logsMeasured: logResult.measured,
    captureCounts: captureResult.result,
    captureCountsAvailable: captureResult.available,
    captureCountsRequested: true,
  });
}
