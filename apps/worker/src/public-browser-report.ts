import { browserQuery } from './browser-query.js';
import { BrowserReportFilter, type SharedAnalytics } from '@app-health/contracts';

type Traffic = NonNullable<SharedAnalytics['traffic']>;
interface Options {
  accountId: string;
  token: string;
  fetchImpl?: typeof fetch;
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
