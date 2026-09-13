import { normalizeAnalyticsSource, type BrowserReportFilter } from '@app-health/contracts';
import { analyticsSourceSql } from './browser-source-sql.js';

const totals =
  "SUM(IF(blob3 = 'pageview', _sample_interval, 0)) AS pageviews, SUM(IF(blob3 = 'event', _sample_interval, 0)) AS events";
const identities =
  "COUNT(DISTINCT blob7) - MAX(IF(blob7 = '', 1, 0)) AS sessions, COUNT(DISTINCT blob8) - MAX(IF(blob8 = '', 1, 0)) AS visitors";
const visits =
  "COUNT(DISTINCT IF(blob9 = 'new', blob7, '')) - MAX(IF(blob9 = 'new' AND blob7 != '', 0, 1)) AS new_sessions, COUNT(DISTINCT IF(blob9 = 'returning', blob7, '')) - MAX(IF(blob9 = 'returning' AND blob7 != '', 0, 1)) AS returning_sessions, COUNT(DISTINCT IF(blob9 != 'new' AND blob9 != 'returning', blob7, '')) - MAX(IF(blob7 != '' AND blob9 != 'new' AND blob9 != 'returning', 0, 1)) AS unidentified_sessions";
const sample = 'MAX(_sample_interval) AS sample_interval';
const dimensions = {
  audience: [
    ['channels', 'blob13'],
    ['entry_pages', 'blob17'],
    ['countries', 'blob16'],
  ],
  acquisition: [
    ['campaigns', 'blob12'],
    ['channels', 'blob13'],
    ['mediums', 'blob11'],
    ['contents', 'blob18'],
    ['terms', 'blob19'],
  ],
  technology: [
    ['devices', 'blob14'],
    ['browsers', 'blob15'],
    ['countries', 'blob16'],
  ],
};
const engagementSource = (
  workspace: string,
  filter: BrowserReportFilter,
  from: number,
  to: number,
) => scopedSource(workspace, filter, from, to);
export function hasSegmentFilter(filter: BrowserReportFilter) {
  return [
    'country',
    'source',
    'path',
    'entry_path',
    'device',
    'browser',
    'channel',
    'campaign',
    'medium',
    'content',
    'term',
  ].some((key) => filter[key as keyof BrowserReportFilter] !== undefined);
}
function canonicalSource(value: string) {
  return value === 'Unknown' ? 'Unknown' : normalizeAnalyticsSource(value);
}
function scopedSource(workspace: string, filter: BrowserReportFilter, from: number, to: number) {
  const clauses = [`index1 = '${workspace}'`, `double2 >= ${from}`, `double2 < ${to}`];
  if (filter.app_id) clauses.push(`blob1 = '${filter.app_id}'`);
  if (filter.environment_id) clauses.push(`blob2 = '${filter.environment_id}'`);
  if (filter.event) clauses.push(`blob5 = '${filter.event}'`);
  if (filter.path) clauses.push(`blob4 = ${sqlLiteral(filter.path)}`);
  if (filter.entry_path) clauses.push(`blob17 = ${sqlLiteral(filter.entry_path)}`);
  if (filter.country)
    clauses.push(`IF(blob16 = '', 'Unknown', blob16) = ${sqlLiteral(filter.country)}`);
  if (filter.device)
    clauses.push(`IF(blob14 = '', 'Unknown', blob14) = ${sqlLiteral(filter.device)}`);
  if (filter.browser)
    clauses.push(`IF(blob15 = '', 'Unknown', blob15) = ${sqlLiteral(filter.browser)}`);
  if (filter.channel)
    clauses.push(`IF(blob13 = '', 'Unknown', blob13) = ${sqlLiteral(filter.channel)}`);
  if (filter.campaign) clauses.push(`blob12 = ${sqlLiteral(filter.campaign)}`);
  if (filter.medium) clauses.push(`blob11 = ${sqlLiteral(filter.medium)}`);
  if (filter.content) clauses.push(`blob18 = ${sqlLiteral(filter.content)}`);
  if (filter.term) clauses.push(`blob19 = ${sqlLiteral(filter.term)}`);
  const source = `FROM app_health_browser_v1 WHERE ${clauses.join(' AND ')}`;
  // Project this long expression once: repeating it in SELECT and WHERE can
  // exceed Analytics Engine's 10,000-character limit for an entire query.
  return filter.source
    ? `FROM (SELECT *, ${analyticsSourceSql("IF(blob10 != '', blob10, blob6)")} AS normalized_source ${source}) WHERE normalized_source = ${sqlLiteral(canonicalSource(filter.source))}`
    : source;
}
function sqlLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}
function ranking(blob: string, source: string) {
  return `SELECT ${blob} AS name, SUM(_sample_interval) AS count, ${sample} ${source} GROUP BY name ORDER BY count DESC LIMIT 20`;
}
/** All interpolated identifiers originate from validated filters or this fixed projection map. */
export function browserReportPlan(
  workspace: string,
  filter: BrowserReportFilter,
  from: number,
  to: number,
  step: number,
) {
  const source = scopedSource(workspace, filter, from, to);
  const pageSource = source + (filter.event ? '' : " AND blob3 = 'pageview'");
  const dimensionBlobs = dimensions[filter.breakdown ?? 'audience'];
  // AE supports subqueries, but not joins. Grouping first by the scoped session
  // lets us calculate session metrics without reading raw rows into the Worker.
  const sessionSource = engagementSource(workspace, filter, from, to);
  const sessionWhere = sessionSource.slice(sessionSource.indexOf(' WHERE ') + 7);
  const sessionGroups = `(SELECT blob1, blob2, blob7 AS session_id, SUM(IF(blob3 = 'pageview', _sample_interval, 0)) AS pageviews, MAX(double2) - MIN(double2) AS duration_ms, MAX(_sample_interval) AS sample_interval FROM app_health_browser_v1 WHERE ${sessionWhere} AND blob7 != '' GROUP BY blob1, blob2, session_id HAVING pageviews > 0)`;
  const engagement = `SELECT SUM(pageviews) AS pageviews, COUNT() AS pageview_sessions, SUM(IF(pageviews = 1, 1, 0)) AS bounced_sessions, AVG(duration_ms) AS average_session_duration_ms, MAX(sample_interval) AS sample_interval FROM ${sessionGroups}`;
  const exits = `SELECT last_path AS name, COUNT() AS count, MAX(sample_interval) AS sample_interval FROM (SELECT blob1, blob2, blob7 AS session_id, argMax(blob4, double2) AS last_path, MAX(_sample_interval) AS sample_interval FROM app_health_browser_v1 WHERE ${sessionWhere} AND blob3 = 'pageview' AND blob7 != '' GROUP BY blob1, blob2, session_id) GROUP BY name ORDER BY count DESC, name ASC LIMIT 20`;
  const sql = [
    `SELECT FLOOR((double2 - ${from}) / ${step}) AS bucket, ${totals}, ${sample} ${source} GROUP BY bucket ORDER BY bucket LIMIT 24`,
    ranking('blob4', pageSource),
    ranking(
      filter.source ? 'normalized_source' : analyticsSourceSql("IF(blob10 != '', blob10, blob6)"),
      pageSource,
    ),
    `SELECT blob5 AS name, SUM(_sample_interval) AS count, MAX(double2) AS last_seen, ${sample} ${source} AND blob3 = 'event' GROUP BY name ORDER BY count DESC LIMIT 100`,
    `SELECT ${identities}, ${visits}, ${sample} ${source}`,
    ...dimensionBlobs.map(([key, blob]) => {
      const expression = key === 'countries' ? "IF(blob16 = '', 'Unknown', blob16)" : blob;
      const dimensionSource = key === 'countries' ? pageSource : `${pageSource} AND ${blob} != ''`;
      return ranking(expression, dimensionSource);
    }),
    `SELECT ${totals}, ${identities}, ${sample} ${scopedSource(workspace, filter, from - (to - from), from)}`,
  ];
  if (!filter.event && !hasSegmentFilter(filter)) sql.push(engagement, exits);
  return { sql, dimensionBlobs };
}
