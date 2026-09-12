import { browserReportPlan } from './browser-report-plan.js';
import { browserQuery } from './browser-query.js';
import { type BrowserReport, BrowserReportFilter } from '@app-health/contracts';
import { reportWindow } from './browser-report-window.js';
type QueryOptions = { accountId: string; token: string; fetchImpl?: typeof fetch };

interface QueryResponse {
  data: QueryRow[];
}
interface QueryRow {
  name?: string;
  count?: number | string;
  last_seen?: number | string;
  bucket?: number | string;
  pageviews?: number | string;
  events?: number | string;
  sessions?: number | string;
  visitors?: number | string;
  new_sessions?: number | string;
  returning_sessions?: number | string;
  unidentified_sessions?: number | string;
  sample_interval: number | string;
}
const number = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    throw new Error('invalid analytical response');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('invalid analytical response');
  return n;
};
const sampleInterval = (value: unknown): number => (value == null ? 0 : number(value));
async function query(sql: string, options: QueryOptions): Promise<QueryRow[]> {
  const response = await browserQuery(sql, options);
  if (!response.ok) throw new Error('event reports unavailable');
  const body = (await response.json()) as QueryResponse;
  if (!Array.isArray(body.data) || body.data.length > 100)
    throw new Error('invalid analytical response');
  return body.data;
}
export async function queryBrowserReport(
  workspace: string,
  filter: BrowserReportFilter,
  options: QueryOptions,
): Promise<BrowserReport> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspace) || !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('invalid analytics scope');
  filter = BrowserReportFilter.parse(filter);
  const { from, to, step } = reportWindow(filter, Date.now());
  const {
    trend,
    pages,
    sources,
    events,
    audienceRows,
    dimensionRows,
    previousRows,
    dimensionBlobs,
  } = await loadReport(workspace, filter, from, to, step, options);
  const series = Array.from({ length: 24 }, (_, i) => ({
    timestamp: from + i * step,
    pageviews: 0,
    events: 0,
  }));
  const seen = new Set<number>();
  for (const row of trend) {
    const bucket = number(row.bucket);
    if (!Number.isInteger(bucket) || bucket > 23 || seen.has(bucket))
      throw new Error('invalid trend bucket');
    seen.add(bucket);
    series[bucket].pageviews = number(row.pageviews);
    series[bucket].events = number(row.events);
  }
  return {
    from,
    to,
    source: 'analytics-engine',
    sampled: [
      ...trend,
      ...pages,
      ...sources,
      ...events,
      ...audienceRows,
      ...dimensionRows.flat(),
      ...previousRows,
    ].some((row) => sampleInterval(row.sample_interval) > 1),
    series,
    pages: ranked(pages),
    sources: ranked(sources),
    events: ranked(events).map((row, i) => ({ ...row, last_seen: number(events[i].last_seen) })),
    sessions: aggregateValue(audienceRows, 'sessions'),
    audience: audienceResult(audienceRows, dimensionBlobs, dimensionRows),
    previous: previousResult(previousRows),
  };
}

const ranked = (rows: QueryRow[]) =>
  rows.map((row) => {
    if (typeof row.name !== 'string') throw new Error('invalid analytical name');
    return { name: row.name || 'Direct / unknown', count: number(row.count) };
  });

function aggregateValue(rows: QueryRow[], key: keyof QueryRow) {
  if (rows.length > 1 || (rows.length === 1 && !(key in rows[0])))
    throw new Error('invalid aggregate response');
  return number(rows[0]?.[key] ?? 0);
}
function audienceResult(
  audienceRows: QueryRow[],
  dimensionBlobs: string[][],
  dimensionRows: QueryRow[][],
): NonNullable<BrowserReport['audience']> {
  return {
    visitors: aggregateValue(audienceRows, 'visitors'),
    new_sessions: aggregateValue(audienceRows, 'new_sessions'),
    returning_sessions: aggregateValue(audienceRows, 'returning_sessions'),
    unidentified_sessions: aggregateValue(audienceRows, 'unidentified_sessions'),
    channels: [],
    campaigns: [],
    devices: [],
    browsers: [],
    countries: [],
    entry_pages: [],
    ...Object.fromEntries(
      dimensionBlobs.map(([key], index) => [key, ranked(dimensionRows[index] ?? [])]),
    ),
  };
}

function previousResult(rows: QueryRow[]): NonNullable<BrowserReport['previous']> {
  return {
    pageviews: aggregateValue(rows, 'pageviews'),
    events: aggregateValue(rows, 'events'),
    sessions: aggregateValue(rows, 'sessions'),
    visitors: aggregateValue(rows, 'visitors'),
  };
}

async function loadReport(
  workspace: string,
  filter: BrowserReportFilter,
  from: number,
  to: number,
  step: number,
  options: QueryOptions,
) {
  const plan = browserReportPlan(workspace, filter, from, to, step);
  const results = await Promise.all(plan.sql.map((sql) => query(sql, options)));
  const [trend, pages, sources, events, audienceRows, ...rest] = results;
  const previousRows = rest.pop() ?? [];
  return {
    trend,
    pages,
    sources,
    events,
    audienceRows,
    dimensionRows: rest,
    previousRows,
    dimensionBlobs: plan.dimensionBlobs,
  };
}
