import { browserQuery } from './browser-query.js';
import { BrowserReportFilter, type SharedAnalytics } from '@app-health/contracts';

type Traffic = NonNullable<SharedAnalytics['traffic']>;
interface Options {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
}

type Row = {
  bucket?: unknown;
  pageviews?: unknown;
  events?: unknown;
  sessions?: unknown;
  name?: unknown;
  count?: unknown;
  sample_interval?: unknown;
};

async function rows(sql: string, options: Options): Promise<Row[]> {
  const response = await browserQuery(sql, options);
  if (!response.ok) throw new Error('Public analytics unavailable');
  const body = (await response.json()) as { data?: Row[] };
  if (!Array.isArray(body.data) || body.data.length > 100)
    throw new Error('Invalid public analytics');
  return body.data;
}

/** Four aggregate queries for opt-in public breakdowns; named events are excluded. */
export async function queryPublicBrowserBreakdowns(
  workspace: string,
  appId: string,
  environmentId: string,
  options: Options,
): Promise<{
  traffic: Traffic;
  sampled: boolean;
  breakdowns: NonNullable<SharedAnalytics['breakdowns']>;
}> {
  BrowserReportFilter.parse({ app_id: appId, environment_id: environmentId });
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspace) || !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('Invalid analytics scope');
  const to = Date.now();
  const from = to - 86400000;
  const step = 3600000;
  const source = `FROM app_health_browser_v1 WHERE index1 = '${workspace}' AND blob1 = '${appId}' AND blob2 = '${environmentId}' AND double2 >= ${from} AND double2 < ${to}`;
  const [trend, pages, sources, sessions] = await Promise.all([
    rows(
      `SELECT FLOOR((double2 - ${from}) / ${step}) AS bucket, SUM(IF(blob3 = 'pageview', _sample_interval, 0)) AS pageviews, SUM(IF(blob3 = 'event', _sample_interval, 0)) AS events, MAX(_sample_interval) AS sample_interval ${source} GROUP BY bucket ORDER BY bucket LIMIT 24`,
      options,
    ),
    rows(
      `SELECT blob4 AS name, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sample_interval ${source} AND blob3 = 'pageview' GROUP BY name ORDER BY count DESC LIMIT 20`,
      options,
    ),
    rows(
      `SELECT IF(blob10 != '', blob10, blob6) AS name, SUM(_sample_interval) AS count, MAX(_sample_interval) AS sample_interval ${source} AND blob3 = 'pageview' GROUP BY name ORDER BY count DESC LIMIT 20`,
      options,
    ),
    rows(
      `SELECT COUNT(DISTINCT blob7) AS sessions, MAX(_sample_interval) AS sample_interval ${source} AND blob7 != ''`,
      options,
    ),
  ]);
  const pulse = publicTrend(trend, from, step);
  const pageRows = publicRanking(pages, 256, false);
  const sourceRows = publicRanking(sources, 253, true);
  const visits = publicSessions(sessions);
  return {
    traffic: {
      from,
      to,
      series: pulse.series,
      pageviews: pulse.series.reduce((sum, row) => sum + row.pageviews, 0),
    },
    sampled: pulse.sampled || pageRows.sampled || sourceRows.sampled || visits.sampled,
    breakdowns: {
      sessions: visits.count,
      events: pulse.events,
      pages: pageRows.rows,
      sources: sourceRows.rows,
    },
  };
}

function sampleInterval(value: unknown): number {
  const interval = validNumber(value);
  if (interval < 1) throw new Error('Invalid public sampling interval');
  return interval;
}

function publicTrend(rows: Row[], from: number, step: number) {
  if (rows.length > 24) throw new Error('Invalid public trend bounds');
  const series = Array.from({ length: 24 }, (_, i) => ({
    timestamp: from + i * step,
    pageviews: 0,
  }));
  const seen = new Set<number>();
  let sampled = false;
  let events = 0;
  for (const row of rows) {
    const bucket = validNumber(row.bucket);
    if (!Number.isInteger(bucket) || bucket > 23 || seen.has(bucket))
      throw new Error('Invalid public trend');
    seen.add(bucket);
    const interval = sampleInterval(row.sample_interval);
    sampled = interval > 1 || sampled;
    series[bucket].pageviews = validNumber(row.pageviews);
    events += validNumber(row.events);
  }
  return { series, sampled, events };
}

function publicRanking(items: Row[], maxLength: number, direct: boolean) {
  if (items.length > 20) throw new Error('Invalid public ranking bounds');
  let sampled = false;
  const rows = items.map((row) => {
    if (
      typeof row.name !== 'string' ||
      row.name.length > maxLength ||
      (!direct && !row.name.startsWith('/'))
    )
      throw new Error('Invalid public name');
    const interval = sampleInterval(row.sample_interval);
    sampled = interval > 1 || sampled;
    return { name: row.name || 'Direct / unknown', count: validNumber(row.count) };
  });
  return { rows, sampled };
}

function publicSessions(items: Row[]) {
  if (items.length > 1) throw new Error('Invalid public sessions bounds');
  if (!items.length) return { count: 0, sampled: false };
  const count = validNumber(items[0].sessions);
  if (!Number.isInteger(count)) throw new Error('Invalid public sessions');
  if (count === 0 && items[0].sample_interval === null) return { count, sampled: false };
  return { count, sampled: sampleInterval(items[0].sample_interval) > 1 };
}

/** One aggregate-only query; private dimensions are never selected for a public report. */
export async function queryPublicBrowserTraffic(
  workspace: string,
  appId: string,
  environmentId: string,
  options: Options,
): Promise<{ traffic: Traffic; sampled: boolean }> {
  const filter = BrowserReportFilter.parse({ app_id: appId, environment_id: environmentId });
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(workspace) || !/^[a-f0-9]{32}$/i.test(options.accountId))
    throw new Error('Invalid analytics scope');
  const to = Date.now();
  const from = to - 86400000;
  const step = 3600000;
  const sql = `SELECT FLOOR((double2 - ${from}) / ${step}) AS bucket, SUM(_sample_interval) AS pageviews, MAX(_sample_interval) AS sample_interval FROM app_health_browser_v1 WHERE index1 = '${workspace}' AND blob1 = '${filter.app_id}' AND blob2 = '${filter.environment_id}' AND blob3 = 'pageview' AND double2 >= ${from} AND double2 < ${to} GROUP BY bucket ORDER BY bucket LIMIT 24`;
  const response = await browserQuery(sql, options);
  if (!response.ok) throw new Error('Traffic unavailable');
  const body = (await response.json()) as {
    data: { bucket: unknown; pageviews: unknown; sample_interval: unknown }[];
  };
  if (!Array.isArray(body.data) || body.data.length > 24) throw new Error('Invalid traffic');
  const series = Array.from({ length: 24 }, (_, i) => ({
    timestamp: from + i * step,
    pageviews: 0,
  }));
  const seen = new Set<number>();
  let sampled = false;
  for (const row of body.data) {
    const bucket = validNumber(row.bucket);
    const count = validNumber(row.pageviews);
    const interval = validNumber(row.sample_interval);
    if (!Number.isInteger(bucket) || bucket > 23 || seen.has(bucket) || interval < 1)
      throw new Error('Invalid traffic bucket');
    seen.add(bucket);
    series[bucket].pageviews = count;
    sampled ||= interval > 1;
  }
  return {
    traffic: { from, to, series, pageviews: series.reduce((sum, row) => sum + row.pageviews, 0) },
    sampled,
  };
}
function validNumber(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '')
    throw new Error('Invalid traffic value');
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error('Invalid traffic value');
  return number;
}
