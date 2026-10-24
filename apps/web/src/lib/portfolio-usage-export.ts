import { BrowserReport, type BrowserReport as BrowserReportData } from '@app-health/contracts';

export interface PortfolioUsageProject {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

export interface PortfolioUsageCatalogProduct {
  catalog_id: string;
  app_id: string;
  name: string;
  browser_visitors_applicability: 'applicable' | 'not_applicable' | 'unknown';
  browser_visitors_unknown_reason?: string;
  coverage: 'full' | 'partial' | 'unknown';
}

interface PortfolioUsageEvent {
  name: string;
  count: number;
  lastSeen: string | null;
  precision: 'exact' | 'estimate';
}

interface PortfolioUsageRecord {
  windowStart: string;
  windowEnd: string;
  checkedAt: string;
  proxy: {
    count: number | null;
    unit: 'browsers' | 'sessions';
    precision: 'exact' | 'lower_bound' | 'estimate' | 'unknown';
  };
  core: {
    count: number | null;
    definition: string;
    lastUsedAt: string | null;
    qualified: false;
    precision: 'unknown';
    coverage: 'unknown';
  };
  tracking: 'partial' | 'missing';
  evidence: Array<{ source: string; date: string; note: string }>;
  limitations: string;
  events?: PortfolioUsageEvent[];
}

export interface PortfolioUsageExport {
  kind: 'portfolio-usage';
  schemaVersion: 1;
  usage: {
    schemaVersion: 1;
    updatedAt: string;
    records: Record<string, PortfolioUsageRecord>;
  };
}

interface ExportOptions {
  ownerToken: string;
  products: PortfolioUsageCatalogProduct[];
  projects: PortfolioUsageProject[];
  signal: AbortSignal;
  now?: () => number;
  concurrency?: number;
  requestTimeoutMs?: number;
  fetcher?: typeof fetch;
}

const MAX_PRODUCTS = 55;
const MAX_EVENTS = 100;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 8_000;
const EVIDENCE_SOURCE = 'app-health.browser-report';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const SAFE_EVENT_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/;
const CORE_UNQUALIFIED = 'No owner-reviewed core action is mapped; event names are unqualified.';

function iso(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 8.64e15) return null;
  return new Date(value).toISOString();
}

function periodAt(timestamp: number): { windowStart: string; windowEnd: string } {
  return {
    windowStart: new Date(timestamp - THIRTY_DAYS_MS).toISOString(),
    windowEnd: new Date(timestamp).toISOString(),
  };
}

function unknownRecord(checkedAt: string, requestedAt: number, note: string): PortfolioUsageRecord {
  const { windowStart, windowEnd } = periodAt(requestedAt);
  return {
    windowStart,
    windowEnd,
    checkedAt,
    proxy: { count: null, unit: 'browsers', precision: 'unknown' },
    core: {
      count: null,
      definition: CORE_UNQUALIFIED,
      lastUsedAt: null,
      qualified: false,
      precision: 'unknown',
      coverage: 'unknown',
    },
    tracking: 'missing',
    evidence: [{ source: EVIDENCE_SOURCE, date: checkedAt, note }],
    limitations: `${note} Unknown is not zero.`.slice(0, 2_000),
  };
}

interface ReportWindow {
  windowStart: string;
  windowEnd: string;
}

interface ProxyAggregate {
  count: number | null;
  unit: 'browsers' | 'sessions';
  precision: PortfolioUsageRecord['proxy']['precision'];
  omittedInvalidCount: boolean;
}

interface SafeEventAggregates {
  entries: PortfolioUsageEvent[];
  rejected: number;
}

function validReportWindow(report: BrowserReportData, checkedAt: string): ReportWindow | null {
  const validWindowStart = iso(report.from);
  const validWindowEnd = iso(report.to);
  if (!validWindowStart || !validWindowEnd) return null;
  if (report.to - report.from !== THIRTY_DAYS_MS) return null;
  if (report.to > Date.parse(checkedAt)) return null;
  return { windowStart: validWindowStart, windowEnd: validWindowEnd };
}

function hasReportSignal(report: BrowserReportData): boolean {
  const reportedVisitors = report.audience?.visitors;
  const pageviews = report.series.reduce((total, point) => total + point.pageviews, 0);
  const eventSignal = report.events.some((event) => event.count > 0);
  return (reportedVisitors ?? 0) > 0 || report.sessions > 0 || pageviews > 0 || eventSignal;
}

function usableReport(report: BrowserReportData, product: PortfolioUsageCatalogProduct): boolean {
  if (report.source !== 'analytics-engine') return false;
  if (product.browser_visitors_applicability === 'not_applicable') return false;
  if (hasReportSignal(report)) return true;
  return (
    product.browser_visitors_applicability === 'applicable' &&
    product.browser_visitors_unknown_reason !== 'no_qualifying_analytics_receipt'
  );
}

function proxyAggregate(report: BrowserReportData, usable: boolean): ProxyAggregate {
  const visitors = report.audience?.visitors;
  const useSessions = (visitors === 0 || visitors === undefined) && report.sessions > 0;
  let candidate: number | null = null;
  if (usable && useSessions) candidate = report.sessions;
  else if (usable && visitors !== undefined && visitors > 0) candidate = visitors;
  const count =
    candidate !== null && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null;
  return {
    count,
    unit: useSessions ? 'sessions' : 'browsers',
    precision: count === null ? 'unknown' : report.sampled ? 'lower_bound' : 'exact',
    omittedInvalidCount: candidate !== null && count === null,
  };
}

function safeEventAggregates(report: BrowserReportData): SafeEventAggregates {
  const entries: PortfolioUsageEvent[] = [];
  let rejected = 0;
  for (const event of report.events.slice(0, MAX_EVENTS)) {
    if (
      !SAFE_EVENT_NAME.test(event.name) ||
      !Number.isFinite(event.count) ||
      event.count < 0 ||
      event.count > Number.MAX_SAFE_INTEGER
    ) {
      rejected += 1;
      continue;
    }
    const lastSeen = iso(event.last_seen);
    entries.push({
      name: event.name,
      count: event.count,
      lastSeen,
      precision: report.sampled ? 'estimate' : 'exact',
    });
  }
  return { entries, rejected };
}

function reportLimitations(
  report: BrowserReportData,
  product: PortfolioUsageCatalogProduct,
  usable: boolean,
  proxy: ProxyAggregate,
  events: SafeEventAggregates,
): string {
  const notes = [
    'Recognized browser hashes are project and environment scoped: default random IDs may persist in first-party local storage up to 90 days, while integrations may be session-only. They are not people or devices and do not link across projects or devices; sessions fallback is session count, not user count.',
    'Core action is unreviewed; named event occurrences do not establish meaningful product use or verified owner use.',
    'The report API has no first/last-valid-data freshness field; event lastSeen is only an event receipt timestamp.',
    'This export does not qualify full-period bot filtering, QA/automation exclusion or uninterrupted collection; audience counts do not establish human demand.',
  ];
  if (report.sampled)
    notes.push('Sampled audience counts are lower bounds and event counts are estimates.');
  if (report.source === 'local')
    notes.push('Report source is local analytics; production coverage is unverified.');
  if (product.browser_visitors_unknown_reason)
    notes.push(`Daily source qualification: ${product.browser_visitors_unknown_reason}.`);
  if (product.coverage !== 'full') notes.push(`Daily report coverage: ${product.coverage}.`);
  if (!usable) notes.push('Production browser usage was not verified; counts are unknown.');
  if (proxy.omittedInvalidCount)
    notes.push('Proxy count was not a nonnegative safe integer; it was omitted without rounding.');
  if (events.rejected)
    notes.push(
      `Omitted ${events.rejected} event name(s) that did not match the safe identifier rule.`,
    );
  if (report.events.length > MAX_EVENTS) notes.push('Event list was capped at 100 entries.');
  return notes.join(' ').slice(0, 2_000);
}

function reportRecord(
  report: BrowserReportData,
  checkedAt: string,
  product: PortfolioUsageCatalogProduct,
): PortfolioUsageRecord {
  const window = validReportWindow(report, checkedAt);
  if (!window) {
    return unknownRecord(
      checkedAt,
      Date.parse(checkedAt),
      'Report window was malformed, not exactly 30 days, or ended after collection; counts were discarded.',
    );
  }
  const usable = usableReport(report, product);
  const proxy = proxyAggregate(report, usable);
  const events = safeEventAggregates(report);
  return {
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    checkedAt,
    proxy: { count: proxy.count, unit: proxy.unit, precision: proxy.precision },
    core: {
      count: null,
      definition: CORE_UNQUALIFIED,
      lastUsedAt: null,
      qualified: false,
      precision: 'unknown',
      coverage: 'unknown',
    },
    tracking: usable ? 'partial' : 'missing',
    evidence: [
      {
        source: EVIDENCE_SOURCE,
        date: checkedAt,
        note: 'Aggregate rolling 30-day report; no owner or person attribution.',
      },
    ],
    limitations: reportLimitations(report, product, usable, proxy, events),
    events: usable ? events.entries : [],
  };
}

function reportUrl(project: PortfolioUsageProject): string {
  const params = new URLSearchParams({
    range: '30d',
    app_id: project.appId,
    environment_id: project.environmentId,
  });
  return `/v1/analytics/report?${params.toString()}`;
}

async function readProject(
  product: PortfolioUsageCatalogProduct,
  project: PortfolioUsageProject | undefined,
  mappingIssue: string | undefined,
  options: ExportOptions,
  clock: () => number,
): Promise<[string, PortfolioUsageRecord]> {
  const requestedAt = clock();
  const requestedCheckedAt = new Date(requestedAt).toISOString();
  if (!project || mappingIssue || product.browser_visitors_applicability === 'not_applicable') {
    return [
      product.catalog_id,
      unknownRecord(
        requestedCheckedAt,
        requestedAt,
        mappingIssue ??
          (product.browser_visitors_applicability === 'not_applicable'
            ? 'Browser analytics is marked not applicable by the daily source report.'
            : 'No production environment is available in the current App Health project list.'),
      ),
    ];
  }
  const url = reportUrl(project);
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) abort();
  else options.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error('request timed out')),
    options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: options.ownerToken ? { authorization: `Bearer ${options.ownerToken}` } : {},
    });
    if (!response.ok) {
      return [
        product.catalog_id,
        unknownRecord(
          new Date(clock()).toISOString(),
          requestedAt,
          `30-day report returned HTTP ${response.status}; cause not classified.`,
        ),
      ];
    }
    const parsed = BrowserReport.safeParse(await response.json());
    const checkedAt = new Date(clock()).toISOString();
    if (!parsed.success) {
      return [
        product.catalog_id,
        unknownRecord(
          checkedAt,
          requestedAt,
          '30-day report response did not match the aggregate report contract.',
        ),
      ];
    }
    return [product.catalog_id, reportRecord(parsed.data, checkedAt, product)];
  } catch (error) {
    if (options.signal.aborted) throw error;
    const message = controller.signal.aborted
      ? '30-day report request timed out.'
      : '30-day report request failed.';
    return [
      product.catalog_id,
      unknownRecord(new Date(clock()).toISOString(), requestedAt, message),
    ];
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', abort);
  }
}

function validateProjectIds(projects: PortfolioUsageProject[]): void {
  for (const project of projects) {
    const validApp = /^[A-Za-z0-9-]{1,100}$/.test(project.appId);
    const validEnvironment = /^[A-Za-z0-9-]{1,100}$/.test(project.environmentId);
    if (!validApp || !validEnvironment)
      throw new Error('Portfolio export contains an invalid App Health environment mapping.');
  }
}

function validateCatalogProducts(products: PortfolioUsageCatalogProduct[]): void {
  const catalogIds = new Set<string>();
  const appCatalogIds = new Map<string, string>();
  for (const product of products) {
    const validCatalogId = /^[a-z0-9][a-z0-9-]{0,99}$/.test(product.catalog_id);
    const validAppId = /^[A-Za-z0-9-]{1,100}$/.test(product.app_id);
    if (!validCatalogId || !validAppId)
      throw new Error('Portfolio export contains an invalid catalog or App Health project ID.');
    if (catalogIds.has(product.catalog_id))
      throw new Error('Portfolio export contains duplicate catalog IDs.');
    catalogIds.add(product.catalog_id);
    const previousCatalogId = appCatalogIds.get(product.app_id);
    if (previousCatalogId && previousCatalogId !== product.catalog_id) {
      throw new Error('Portfolio export maps one App Health project to multiple catalog IDs.');
    }
    appCatalogIds.set(product.app_id, product.catalog_id);
  }
}

function productionProjects(projects: PortfolioUsageProject[]) {
  const byApp = new Map<string, PortfolioUsageProject>();
  const ambiguousApps = new Set<string>();
  for (const project of projects) {
    if (project.environment !== 'production') continue;
    const previous = byApp.get(project.appId);
    if (previous && previous.environmentId !== project.environmentId) {
      ambiguousApps.add(project.appId);
    } else {
      byApp.set(project.appId, project);
    }
  }
  return { byApp, ambiguousApps };
}

async function readCatalogProduct(
  product: PortfolioUsageCatalogProduct,
  options: ExportOptions,
  projects: ReturnType<typeof productionProjects>,
  clock: () => number,
): Promise<[string, PortfolioUsageRecord]> {
  const project = projects.byApp.get(product.app_id);
  const mappingIssue = projects.ambiguousApps.has(product.app_id)
    ? 'Multiple production environments map to this App Health project; record left unknown.'
    : undefined;
  return readProject(product, project, mappingIssue, options, clock);
}

async function collectCatalogRecords(
  options: ExportOptions,
  clock: () => number,
): Promise<Record<string, PortfolioUsageRecord>> {
  const projects = productionProjects(options.projects);
  const records: Record<string, PortfolioUsageRecord> = {};
  let cursor = 0;
  const worker = async () => {
    while (!options.signal.aborted) {
      const index = cursor++;
      if (index >= options.products.length) return;
      const [catalogId, record] = await readCatalogProduct(
        options.products[index],
        options,
        projects,
        clock,
      );
      records[catalogId] = record;
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 4));
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (options.signal.aborted)
    throw options.signal.reason ?? new DOMException('Export canceled', 'AbortError');
  return records;
}

export async function createPortfolioUsageExport(
  options: ExportOptions,
): Promise<PortfolioUsageExport> {
  if (options.products.length > MAX_PRODUCTS) {
    throw new Error(`Portfolio export is limited to ${MAX_PRODUCTS} catalog products.`);
  }
  validateProjectIds(options.projects);
  validateCatalogProducts(options.products);
  const clock = options.now ?? Date.now;
  const records = await collectCatalogRecords(options, clock);
  const updatedAt = new Date(clock()).toISOString();
  return {
    kind: 'portfolio-usage',
    schemaVersion: 1,
    usage: { schemaVersion: 1, updatedAt, records },
  };
}
