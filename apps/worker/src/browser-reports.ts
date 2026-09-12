import { browserQuery } from './browser-query.js';
import { type BrowserReport, BrowserReportFilter } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';

function reportWindow(filter: BrowserReportFilter, now: number) {
  const duration = filter.range === '1h' ? 3_600_000 : 86_400_000;
  return { from: now - duration, to: now, step: duration / 24 };
}
function rank(counts: Map<string, number>) {
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 20);
}
export function localBrowserReport(
  batches: Iterable<CollectedBrowserBatch>,
  filter: BrowserReportFilter,
  now = Date.now(),
): BrowserReport {
  const { from, to, step } = reportWindow(filter, now);
  const series = Array.from({ length: 24 }, (_, i) => ({
    timestamp: from + i * step,
    pageviews: 0,
    events: 0,
  }));
  const pages = new Map<string, number>();
  const sources = new Map<string, number>();
  const events = new Map<string, { name: string; count: number; last_seen: number }>();
  for (const batch of batches) {
    if (
      (filter.app_id && batch.app_id !== filter.app_id) ||
      (filter.environment_id && batch.environment_id !== filter.environment_id)
    )
      continue;
    for (const event of batch.events) {
      if (
        event.timestamp < from ||
        event.timestamp >= to ||
        (filter.event && event.name !== filter.event)
      )
        continue;
      const bucket = series[Math.floor((event.timestamp - from) / step)];
      if (event.type === 'pageview') bucket.pageviews++;
      else bucket.events++;
      if (event.type === 'pageview' || filter.event) {
        pages.set(event.path, (pages.get(event.path) ?? 0) + 1);
        sources.set(
          event.referrer || 'Direct / unknown',
          (sources.get(event.referrer || 'Direct / unknown') ?? 0) + 1,
        );
      }
      if (event.name) {
        const row = events.get(event.name) ?? { name: event.name, count: 0, last_seen: 0 };
        row.count++;
        row.last_seen = Math.max(row.last_seen, event.timestamp);
        events.set(event.name, row);
      }
    }
  }
  return {
    from,
    to,
    sampled: false,
    source: 'local',
    series,
    pages: rank(pages),
    sources: rank(sources),
    events: [...events.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 100),
  };
}

interface QueryRow {
  name?: string;
  count?: number | string;
  last_seen?: number | string;
  bucket?: number | string;
  pageviews?: number | string;
  events?: number | string;
  sample_interval: number | string;
}
const number = (value: unknown): number => {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    throw new Error('invalid analytical response');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('invalid analytical response');
  return n;
};
async function query(
  sql: string,
  options: { accountId: string; token: string; fetchImpl?: typeof fetch },
): Promise<QueryRow[]> {
  const response = await browserQuery(sql, options);
  if (!response.ok) throw new Error('event reports unavailable');
  const body = (await response.json()) as { data: QueryRow[] };
  if (!Array.isArray(body.data) || body.data.length > 100)
    throw new Error('invalid analytical response');
  return body.data;
}
export async function queryBrowserReport(
  workspace: string,
  filter: BrowserReportFilter,
  options: { accountId: string; token: string; fetchImpl?: typeof fetch },
): Promise<BrowserReport> {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspace) || !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('invalid analytics scope');
  filter = BrowserReportFilter.parse(filter);
  const { from, to, step } = reportWindow(filter, Date.now());
  const clauses = [`index1 = '${workspace}'`, `double2 >= ${from}`, `double2 < ${to}`];
  if (filter.app_id) clauses.push(`blob1 = '${filter.app_id}'`);
  if (filter.environment_id) clauses.push(`blob2 = '${filter.environment_id}'`);
  if (filter.event) clauses.push(`blob5 = '${filter.event}'`);
  const source = `FROM app_health_browser_v1 WHERE ${clauses.join(' AND ')}`;
  const pageCondition = filter.event ? '' : " AND blob3 = 'pageview'";
  const [trend, pages, sources, events] = await Promise.all([
    query(
      `SELECT FLOOR((double2 - ${from}) / ${step}) AS bucket, SUM(IF(blob3 = 'pageview', _sample_interval, 0)) AS pageviews, SUM(IF(blob3 = 'event', _sample_interval, 0)) AS events, MAX(_sample_interval) AS sample_interval ${source} GROUP BY bucket ORDER BY bucket LIMIT 24`,
      options,
    ),
    query(
      `SELECT blob4 AS name, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sample_interval ${source}${pageCondition} GROUP BY name ORDER BY count DESC LIMIT 20`,
      options,
    ),
    query(
      `SELECT blob6 AS name, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sample_interval ${source}${pageCondition} GROUP BY name ORDER BY count DESC LIMIT 20`,
      options,
    ),
    query(
      `SELECT blob5 AS name, SUM(_sample_interval) AS count, MAX(double2) AS last_seen, MAX(_sample_interval) AS sample_interval ${source} AND blob3 = 'event' GROUP BY name ORDER BY count DESC LIMIT 100`,
      options,
    ),
  ]);
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
  const ranked = (rows: QueryRow[]) =>
    rows.map((row) => {
      if (typeof row.name !== 'string') throw new Error('invalid analytical name');
      return { name: row.name || 'Direct / unknown', count: number(row.count) };
    });
  return {
    from,
    to,
    source: 'analytics-engine',
    sampled: [...trend, ...pages, ...sources, ...events].some(
      (row) => number(row.sample_interval) > 1,
    ),
    series,
    pages: ranked(pages),
    sources: ranked(sources),
    events: ranked(events).map((row, i) => ({ ...row, last_seen: number(events[i].last_seen) })),
  };
}
