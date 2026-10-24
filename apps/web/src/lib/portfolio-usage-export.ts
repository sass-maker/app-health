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

export interface PortfolioUsageEvent {
  name: string;
  count: number;
  lastSeen: string | null;
  precision: 'exact' | 'estimate';
}

export interface PortfolioUsageRecord {
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

function reportRecord(
  report: BrowserReportData,
  checkedAt: string,
  product: PortfolioUsageCatalogProduct,
): PortfolioUsageRecord {
  const validWindowStart = iso(report.from);
  const validWindowEnd = iso(report.to);
  const checkedAtMs = Date.parse(checkedAt);
  const exactThirtyDayWindow =
    validWindowStart !== null &&
    validWindowEnd !== null &&
    report.to - report.from === THIRTY_DAYS_MS &&
    report.to <= checkedAtMs;
  if (!exactThirtyDayWindow) {
    return unknownRecord(
      checkedAt,
      checkedAtMs,
      'Report window was malformed, not exactly 30 days, or ended after collection; counts were discarded.',
    );
  }
  const window = { windowStart: validWindowStart, windowEnd: validWindowEnd };
  const reportedVisitors = report.audience?.visitors;
  const sessions = report.sessions;
  const pageviews = report.series.reduce((total, point) => total + point.pageviews, 0);
  const eventSignal = report.events.some((event) => event.count > 0);
  const hasReportSignal =
    (reportedVisitors ?? 0) > 0 || sessions > 0 || pageviews > 0 || eventSignal;
  const dailySourceQualified =
    product.browser_visitors_applicability === 'applicable' &&
    product.browser_visitors_unknown_reason !== 'no_qualifying_analytics_receipt';
  const reportSourceQualified = report.source === 'analytics-engine';
  const isUsable =
    product.browser_visitors_applicability !== 'not_applicable' &&
    reportSourceQualified &&
    (hasReportSignal || dailySourceQualified);
  const useSessions = (reportedVisitors === 0 || reportedVisitors === undefined) && sessions > 0;
  const proxyCount = !isUsable
    ? null
    : useSessions
      ? sessions
      : reportedVisitors && reportedVisitors > 0
        ? reportedVisitors
        : null;
  const proxyUnit = useSessions ? 'sessions' : 'browsers';
  const proxyPrecision = proxyCount === null ? 'unknown' : report.sampled ? 'lower_bound' : 'exact';
  const eventEntries: PortfolioUsageEvent[] = [];
  let rejectedEvents = 0;
  for (const event of report.events.slice(0, MAX_EVENTS)) {
    if (
      !SAFE_EVENT_NAME.test(event.name) ||
      !Number.isFinite(event.count) ||
      event.count < 0 ||
      event.count > Number.MAX_SAFE_INTEGER
    ) {
      rejectedEvents += 1;
      continue;
    }
    const lastSeen = iso(event.last_seen);
    eventEntries.push({
      name: event.name,
      count: event.count,
      lastSeen,
      precision: report.sampled ? 'estimate' : 'exact',
    });
  }
  const limitations = [
    'Recognized browser hashes are not people or devices; sessions fallback is session count, not user count.',
    'Core action is unreviewed; named event occurrences do not establish meaningful product use or verified owner use.',
    'The report API has no first/last-valid-data freshness field; event lastSeen is only an event receipt timestamp.',
    ...(!validWindowStart || !validWindowEnd
      ? ['The report returned invalid window timestamps; a request-time 30-day window is shown.']
      : []),
    ...(report.sampled
      ? ['Sampled audience counts are lower bounds and event counts are estimates.']
      : []),
    ...(report.source === 'local'
      ? ['Report source is local analytics; production coverage is unverified.']
      : []),
    ...(product.browser_visitors_unknown_reason
      ? [`Daily source qualification: ${product.browser_visitors_unknown_reason}.`]
      : []),
    ...(product.coverage !== 'full' ? [`Daily report coverage: ${product.coverage}.`] : []),
    ...(!isUsable ? ['Production browser usage was not verified; counts are unknown.'] : []),
    ...(rejectedEvents
      ? [`Omitted ${rejectedEvents} event name(s) that did not match the safe identifier rule.`]
      : []),
    ...(report.events.length > MAX_EVENTS ? ['Event list was capped at 100 entries.'] : []),
  ];
  return {
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    checkedAt,
    proxy: { count: proxyCount, unit: proxyUnit, precision: proxyPrecision },
    core: {
      count: null,
      definition: CORE_UNQUALIFIED,
      lastUsedAt: null,
      qualified: false,
      precision: 'unknown',
      coverage: 'unknown',
    },
    tracking: isUsable ? 'partial' : 'missing',
    evidence: [
      {
        source: EVIDENCE_SOURCE,
        date: checkedAt,
        note: 'Aggregate rolling 30-day report; no owner or person attribution.',
      },
    ],
    limitations: limitations.join(' ').slice(0, 2_000),
    events: isUsable ? eventEntries : [],
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

export async function createPortfolioUsageExport(
  options: ExportOptions,
): Promise<PortfolioUsageExport> {
  if (options.products.length > MAX_PRODUCTS) {
    throw new Error(`Portfolio export is limited to ${MAX_PRODUCTS} catalog products.`);
  }
  const clock = options.now ?? Date.now;
  const catalogIds = new Set<string>();
  const appCatalogIds = new Map<string, string>();
  for (const project of options.projects) {
    if (
      !/^[A-Za-z0-9-]{1,100}$/.test(project.appId) ||
      !/^[A-Za-z0-9-]{1,100}$/.test(project.environmentId)
    ) {
      throw new Error('Portfolio export contains an invalid App Health environment mapping.');
    }
  }
  for (const product of options.products) {
    if (
      !/^[a-z0-9][a-z0-9-]{0,99}$/.test(product.catalog_id) ||
      !/^[A-Za-z0-9-]{1,100}$/.test(product.app_id)
    ) {
      throw new Error('Portfolio export contains an invalid catalog or App Health project ID.');
    }
    if (catalogIds.has(product.catalog_id)) {
      throw new Error('Portfolio export contains duplicate catalog IDs.');
    }
    catalogIds.add(product.catalog_id);
    const previousCatalogId = appCatalogIds.get(product.app_id);
    if (previousCatalogId && previousCatalogId !== product.catalog_id) {
      throw new Error('Portfolio export maps one App Health project to multiple catalog IDs.');
    }
    appCatalogIds.set(product.app_id, product.catalog_id);
  }
  const projectByApp = new Map<string, PortfolioUsageProject>();
  const ambiguousApps = new Set<string>();
  for (const project of options.projects) {
    if (project.environment !== 'production') continue;
    const previous = projectByApp.get(project.appId);
    if (previous && previous.environmentId !== project.environmentId)
      ambiguousApps.add(project.appId);
    else projectByApp.set(project.appId, project);
  }
  const records: Record<string, PortfolioUsageRecord> = {};
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, 4)) },
    async () => {
      while (!options.signal.aborted) {
        const index = cursor++;
        if (index >= options.products.length) return;
        const product = options.products[index];
        if (records[product.catalog_id]) continue;
        const project = projectByApp.get(product.app_id);
        const mappingIssue = ambiguousApps.has(product.app_id)
          ? 'Multiple production environments map to this App Health project; record left unknown.'
          : undefined;
        const [catalogId, record] = await readProject(
          product,
          project,
          mappingIssue,
          {
            ...options,
            fetcher: options.fetcher ?? fetch,
            requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
          clock,
        );
        records[catalogId] = record;
      }
    },
  );
  await Promise.all(workers);
  if (options.signal.aborted)
    throw options.signal.reason ?? new DOMException('Export canceled', 'AbortError');
  const updatedAt = new Date(clock()).toISOString();
  return {
    kind: 'portfolio-usage',
    schemaVersion: 1,
    usage: { schemaVersion: 1, updatedAt, records },
  };
}
