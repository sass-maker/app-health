import type { BrowserReportFilter } from '@app-health/contracts';

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
  ],
  acquisition: [
    ['campaigns', 'blob12'],
    ['channels', 'blob13'],
  ],
  technology: [
    ['devices', 'blob14'],
    ['browsers', 'blob15'],
    ['countries', 'blob16'],
  ],
};
function scopedSource(workspace: string, filter: BrowserReportFilter, from: number, to: number) {
  const clauses = [`index1 = '${workspace}'`, `double2 >= ${from}`, `double2 < ${to}`];
  if (filter.app_id) clauses.push(`blob1 = '${filter.app_id}'`);
  if (filter.environment_id) clauses.push(`blob2 = '${filter.environment_id}'`);
  if (filter.event) clauses.push(`blob5 = '${filter.event}'`);
  return `FROM app_health_browser_v1 WHERE ${clauses.join(' AND ')}`;
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
  const sql = [
    `SELECT FLOOR((double2 - ${from}) / ${step}) AS bucket, ${totals}, ${sample} ${source} GROUP BY bucket ORDER BY bucket LIMIT 24`,
    ranking('blob4', pageSource),
    ranking("IF(blob10 != '', blob10, blob6)", pageSource),
    `SELECT blob5 AS name, SUM(_sample_interval) AS count, MAX(double2) AS last_seen, ${sample} ${source} AND blob3 = 'event' GROUP BY name ORDER BY count DESC LIMIT 100`,
    `SELECT ${identities}, ${visits}, ${sample} ${source}`,
    ...dimensionBlobs.map(([, blob]) => ranking(blob, `${pageSource} AND ${blob} != ''`)),
    `SELECT ${totals}, ${identities}, ${sample} ${scopedSource(workspace, filter, from - (to - from), from)}`,
  ];
  return { sql, dimensionBlobs };
}
