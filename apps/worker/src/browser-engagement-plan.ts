import type { BrowserReportFilter } from '@app-health/contracts';
import { hasSegmentFilter } from './browser-report-plan.js';

type Row = Record<string, unknown>;
export type EngagementCount = { pageviews: number; events: number };
export type EngagementQueryRow = {
  sample_interval: number | string;
  name?: string;
  count?: number | string;
  pageviews?: number | string;
  pageview_sessions?: number | string;
  bounced_sessions?: number | string;
  average_session_duration_ms?: number | string;
};
export function useOptionalEngagement(filter: BrowserReportFilter): boolean {
  return Boolean(
    filter.app_id &&
    filter.environment_id &&
    !filter.event &&
    !hasSegmentFilter(filter) &&
    filter.breakdown !== 'acquisition' &&
    (filter.range === '1h' || filter.range === '24h'),
  );
}
export function optionalEngagementSql(original: string): string | undefined {
  const index = original.indexOf(' FROM (SELECT ');
  const sample = 'MAX(_sample_interval) AS sample_interval FROM app_health_browser_v1';
  if (index < 0) return undefined;
  const source = original.slice(index + 6);
  if (
    !source.startsWith('(SELECT blob1, blob2, blob7 AS session_id, ') ||
    !source.includes(sample) ||
    !source.includes('GROUP BY blob1, blob2, session_id HAVING pageviews > 0')
  )
    return undefined;
  const inner = source
    .replace('SELECT blob1, blob2, blob7 AS session_id, ', 'SELECT ')
    .replace('GROUP BY blob1, blob2, session_id', 'GROUP BY blob1, blob2, blob7')
    .replace(
      sample,
      "MAX(_sample_interval) AS sample_interval, MAX(IF(blob3 = 'pageview', _sample_interval, 0)) AS pageview_sample_interval, argMax(blob4, IF(blob3 = 'pageview', double2, -1)) AS last_path, COUNT(DISTINCT IF(blob3 = 'pageview', double2, -1)) - MAX(IF(blob3 = 'pageview', 0, 1)) AS distinct_pageview_timestamps FROM app_health_browser_v1",
    );
  if (
    inner.includes('session_id') ||
    !inner.includes('GROUP BY blob1, blob2, blob7 HAVING pageviews > 0')
  )
    return undefined;
  const sql = `SELECT last_path AS name, COUNT() AS count, SUM(pageviews) AS pageviews, SUM(IF(pageviews = 1, 1, 0)) AS bounced_sessions, SUM(duration_ms) AS duration_sum, MAX(sample_interval) AS sample_interval, MAX(pageview_sample_interval) AS pageview_sample_interval, SUM(IF(pageviews = distinct_pageview_timestamps, 0, 1)) AS ambiguous_sessions FROM ${inner} GROUP BY name ORDER BY count DESC, name ASC LIMIT 21`;
  return new TextEncoder().encode(sql).length <= 10_000 ? sql : undefined;
}
function integer(value: unknown): number {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '')
    throw new Error('Invalid engagement number');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid engagement number');
  return number;
}
function row(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid engagement row');
  return value as Row;
}
function count(value: Row): EngagementCount {
  if (integer(value.sample_interval) !== 1) throw new Error('Sampled engagement control');
  return { pageviews: integer(value.pageviews), events: integer(value.events) };
}
function small(value: EngagementCount): EngagementCount | undefined {
  const total = value.pageviews + value.events;
  return total >= 1 && total <= 100 ? value : undefined;
}
export function engagementCounter(
  values: readonly unknown[],
  current: boolean,
): EngagementCount | undefined {
  try {
    const seen = new Set<number>();
    let result: EngagementCount = { pageviews: 0, events: 0 };
    for (const value of values) {
      const item = row(value),
        key = integer(item[current ? 'period' : 'bucket']);
      if (seen.has(key) || key > (current ? 1 : 23)) return undefined;
      seen.add(key);
      if (current && key !== 1) continue;
      const totals = count(item);
      result = {
        pageviews: result.pageviews + totals.pageviews,
        events: result.events + totals.events,
      };
      if (!Number.isSafeInteger(result.pageviews) || !Number.isSafeInteger(result.events))
        return undefined;
    }
    return current && !seen.has(1) ? undefined : small(result);
  } catch {
    return undefined;
  }
}
export function sameEngagementCount(left: EngagementCount, right: EngagementCount): boolean {
  return left.pageviews === right.pageviews && left.events === right.events;
}
function byteOrder(left: string, right: string): number {
  const encoder = new TextEncoder(),
    a = encoder.encode(left),
    b = encoder.encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
const keys = [
  'name',
  'count',
  'pageviews',
  'bounced_sessions',
  'duration_sum',
  'sample_interval',
  'pageview_sample_interval',
  'ambiguous_sessions',
].sort();
function engagementPath(name: unknown): string {
  if (
    typeof name !== 'string' ||
    name.length > 256 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(name)
  )
    throw new Error('Invalid engagement path');
  return name;
}
function pathRow(value: unknown, duration: number) {
  const item = row(value);
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(keys))
    throw new Error('Invalid engagement fields');
  const name = engagementPath(item.name);
  const sessions = integer(item.count),
    pageviews = integer(item.pageviews);
  const bounced = integer(item.bounced_sessions),
    elapsed = integer(item.duration_sum);
  if (
    integer(item.sample_interval) !== 1 ||
    integer(item.pageview_sample_interval) !== 1 ||
    integer(item.ambiguous_sessions) !== 0
  )
    throw new Error('Uncertain engagement aggregate');
  if (!sessions || pageviews < sessions || bounced > sessions || elapsed > duration * sessions)
    throw new Error('Invalid engagement totals');
  return { name, sessions, pageviews, bounced, elapsed };
}
export function foldEngagement(
  data: unknown,
  control: EngagementCount,
  duration: number,
): EngagementQueryRow[][] {
  if (!Array.isArray(data) || data.length > 20) throw new Error('Incomplete engagement paths');
  const seen = new Set<string>();
  const paths = data.map((value) => pathRow(value, duration));
  let pageviews = 0,
    sessions = 0,
    bounced = 0,
    elapsed = 0;
  let previous: (typeof paths)[number] | undefined;
  for (const item of paths) {
    if (
      seen.has(item.name) ||
      (previous &&
        (item.sessions > previous.sessions ||
          (item.sessions === previous.sessions && byteOrder(previous.name, item.name) > 0)))
    )
      throw new Error('Invalid engagement path order');
    seen.add(item.name);
    previous = item;
    pageviews += item.pageviews;
    sessions += item.sessions;
    bounced += item.bounced;
    elapsed += item.elapsed;
  }
  if (
    ![pageviews, sessions, bounced, elapsed].every(Number.isSafeInteger) ||
    pageviews !== control.pageviews
  )
    throw new Error('Incomplete identified pageviews');
  return [
    [
      {
        pageviews,
        pageview_sessions: sessions,
        bounced_sessions: bounced,
        average_session_duration_ms: sessions ? elapsed / sessions : 0,
        sample_interval: paths.length ? 1 : 0,
      },
    ],
    paths.map((item) => ({ name: item.name, count: item.sessions, sample_interval: 1 })),
  ];
}
