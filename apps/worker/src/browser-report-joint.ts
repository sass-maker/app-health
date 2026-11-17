import type { BrowserReportFilter } from '@app-health/contracts';
import { analyticsSourceFrom, analyticsSourceSql } from './browser-source-sql.js';

type Row = Record<string, unknown>;
type Rank = { name: string; count: number; sample_interval: number; last_seen: number };
type Totals = { pageviews: number; events: number };
const fields = ['event_kind', 'page_path', 'event_name', 'source_name', 'dim0', 'dim1', 'dim2'];
const rowKeys = [...fields, 'count', 'last_seen', 'sample_interval'].sort();

export function useEagerRankings(filter: BrowserReportFilter): boolean {
  return Boolean(
    filter.app_id &&
    filter.environment_id &&
    filter.breakdown !== 'acquisition' &&
    filter.range !== '7d' &&
    filter.range !== '30d',
  );
}

export function jointRankingSql(source: string, sourceFiltered: boolean, dimensions: string[][]) {
  if (dimensions.length !== 3) return undefined;
  const columns = [
    ...new Set([
      'blob3',
      'blob4',
      'blob5',
      'double2',
      '_sample_interval',
      ...dimensions.map(([, blob]) => blob),
    ]),
  ];
  const browserSource = `${source} AND blob3 IN ('pageview', 'event')`;
  const normalized = (sourceFiltered ? browserSource : analyticsSourceFrom(browserSource)).replace(
    'SELECT *,',
    `SELECT ${columns.join(',')},`,
  );
  const projection = [
    ['event_kind', 'blob3'],
    ['page_path', 'blob4'],
    ['event_name', 'blob5'],
    ['source_name', analyticsSourceSql()],
    ...dimensions.map(([, blob], index) => [`dim${index}`, blob]),
  ];
  const sql = `SELECT ${projection.map(([alias, expression]) => `${expression} AS ${alias}`).join(', ')}, SUM(_sample_interval) AS count, MAX(double2) AS last_seen, MAX(_sample_interval) AS sample_interval ${normalized} GROUP BY ${fields.join(',')} LIMIT 101`;
  return new TextEncoder().encode(sql).length <= 10_000 ? sql : undefined;
}

function integer(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '')
    throw new Error('Invalid joint number');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid joint number');
  return result;
}

function totals(row: Row): Totals {
  if (integer(row.sample_interval) !== 1) throw new Error('Sampled joint control');
  return { pageviews: integer(row.pageviews), events: integer(row.events) };
}

export function currentRankingCounter(rows: readonly Row[]): Totals | undefined {
  try {
    const periods = rows.map((row) => integer(row.period));
    if (periods.some((period) => period > 1) || new Set(periods).size !== rows.length)
      return undefined;
    const current = rows.find((_, index) => periods[index] === 1);
    if (!current) return undefined;
    return lowTraffic(totals(current));
  } catch {
    return undefined;
  }
}

export function trendRankingCounter(rows: readonly Row[]): Totals | undefined {
  try {
    return lowTraffic(trendTotals(rows));
  } catch {
    return undefined;
  }
}

function lowTraffic(count: Totals): Totals | undefined {
  const total = count.pageviews + count.events;
  return total >= 1 && total <= 100 ? count : undefined;
}

export function agreesWithCurrentPeriod(rows: readonly Row[], counter: Totals): boolean {
  const current = currentRankingCounter(rows);
  return current?.pageviews === counter.pageviews && current.events === counter.events;
}

function accumulate(map: Map<string, Rank>, name: string, count: number, lastSeen: number) {
  const previous = map.get(name);
  const combined = (previous?.count ?? 0) + count;
  if (!Number.isSafeInteger(combined)) throw new Error('Joint count overflow');
  map.set(name, {
    name,
    count: combined,
    last_seen: Math.max(previous?.last_seen ?? 0, lastSeen),
    sample_interval: 1,
  });
}

function ranking(map: Map<string, Rank>, limit: number): Rank[] {
  const ordered = [...map.values()].sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
  if (ordered.length > limit && ordered[limit - 1].count === ordered[limit].count)
    throw new Error('Joint ranking cutoff tie');
  return ordered.slice(0, limit);
}

function trendTotals(rows: readonly Row[]): Totals {
  const seen = new Set<number>();
  return rows.reduce<Totals>(
    (sum, row) => {
      const bucket = integer(row.bucket);
      if (bucket > 23 || seen.has(bucket)) throw new Error('Invalid joint trend control');
      seen.add(bucket);
      const count = totals(row);
      sum.pageviews += count.pageviews;
      sum.events += count.events;
      if (!Number.isSafeInteger(sum.pageviews) || !Number.isSafeInteger(sum.events))
        throw new Error('Joint trend overflow');
      return sum;
    },
    { pageviews: 0, events: 0 },
  );
}

function pageCounts(original: readonly Row[]): Map<string, number> {
  const counts = new Map<string, number>();
  let previous = Infinity;
  for (const row of original) {
    if (
      typeof row.name !== 'string' ||
      row.name.length > 256 ||
      counts.has(row.name) ||
      integer(row.sample_interval) !== 1
    )
      throw new Error('Invalid joint pages control');
    const count = integer(row.count);
    if (!count || count > previous) throw new Error('Invalid joint page order');
    counts.set(row.name, count);
    previous = count;
  }
  return counts;
}
function samePages(original: readonly Row[], folded: ReadonlyMap<string, Rank>): boolean {
  if (original.length !== Math.min(20, folded.size)) return false;
  const selected = pageCounts(original);
  const topCounts = [...folded.values()]
    .map((row) => row.count)
    .sort((a, b) => b - a)
    .slice(0, 20);
  return [...selected].every(
    ([name, count], index) => folded.get(name)?.count === count && count === topCounts[index],
  );
}

type JointRow = {
  kind: 'pageview' | 'event';
  path: string;
  event: string;
  source: string;
  dimensions: string[];
  count: number;
  lastSeen: number;
};
function stringLimit(key: string): number {
  if (key === 'event_kind') return 8;
  if (key === 'event_name') return 64;
  if (key === 'source_name') return 253;
  return 256;
}
function decodeJointRow(value: unknown, from: number, to: number): JointRow {
  if (!value || typeof value !== 'object') throw new Error('Invalid joint row');
  const row = value as Row;
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(rowKeys) ||
    fields.some((key) => typeof row[key] !== 'string' || row[key].length > stringLimit(key))
  )
    throw new Error('Invalid joint fields');
  if (row.event_kind !== 'pageview' && row.event_kind !== 'event')
    throw new Error('Invalid joint kind');
  const count = integer(row.count);
  const lastSeen = integer(row.last_seen);
  if (!count || integer(row.sample_interval) !== 1 || lastSeen < from || lastSeen >= to)
    throw new Error('Invalid joint bounds');
  return {
    kind: row.event_kind,
    path: row.page_path as string,
    event: row.event_name as string,
    source: row.source_name as string,
    dimensions: [row.dim0, row.dim1, row.dim2] as string[],
    count,
    lastSeen,
  };
}
function decodeJointRows(data: unknown, from: number, to: number): JointRow[] {
  if (!Array.isArray(data) || data.length > 100) throw new Error('Incomplete joint groups');
  const seen = new Set<string>();
  return data.map((value) => {
    const row = decodeJointRow(value, from, to);
    const key = JSON.stringify([row.kind, row.path, row.event, row.source, row.dimensions]);
    if (seen.has(key)) throw new Error('Duplicate joint group');
    seen.add(key);
    return row;
  });
}

export function validPageControl(rows: readonly Row[]): boolean {
  if (rows.length > 20) return false;
  try {
    pageCounts(rows);
    return true;
  } catch {
    return false;
  }
}

function jointMargins(
  rows: readonly JointRow[],
  filter: BrowserReportFilter,
  dimensionBlobs: string[][],
) {
  const pages = new Map<string, Rank>();
  const sources = new Map<string, Rank>();
  const events = new Map<string, Rank>();
  const dimensions = dimensionBlobs.map(() => new Map<string, Rank>());
  const count: Totals = { pageviews: 0, events: 0 };
  for (const row of rows) {
    count[row.kind === 'pageview' ? 'pageviews' : 'events'] += row.count;
    if (row.kind === 'event') accumulate(events, row.event, row.count, row.lastSeen);
    if (!filter.event && row.kind !== 'pageview') continue;
    accumulate(pages, row.path, row.count, row.lastSeen);
    accumulate(sources, row.source, row.count, row.lastSeen);
    dimensions.forEach((map, index) => {
      const value = row.dimensions[index];
      const country = dimensionBlobs[index][0] === 'countries';
      if (country || value !== '')
        accumulate(map, country && value === '' ? 'Unknown' : value, row.count, row.lastSeen);
    });
  }
  return {
    pages,
    sources: ranking(sources, 20),
    events: ranking(events, 100),
    dimensions: dimensions.map((map) => ranking(map, 20)),
    count,
  };
}

export function prepareJointRankings(args: {
  data: unknown;
  filter: BrowserReportFilter;
  from: number;
  to: number;
  dimensions: string[][];
}) {
  try {
    const folded = jointMargins(
      decodeJointRows(args.data, args.from, args.to),
      args.filter,
      args.dimensions,
    );
    return lowTraffic(folded.count) ? folded : undefined;
  } catch {
    return undefined;
  }
}
export function jointControlsAgree(
  folded: NonNullable<ReturnType<typeof prepareJointRankings>>,
  counter?: Totals,
  pages?: readonly Row[],
): boolean {
  try {
    return (
      (counter === undefined ||
        (folded.count.pageviews === counter.pageviews && folded.count.events === counter.events)) &&
      (pages === undefined || samePages(pages, folded.pages))
    );
  } catch {
    return false;
  }
}
export function foldJointRankings(args: {
  folded: NonNullable<ReturnType<typeof prepareJointRankings>>;
  counter: Totals;
  trend: readonly Row[];
  pages: readonly Row[];
}): { sources: Rank[]; events: Rank[]; dimensions: Rank[][] } | undefined {
  try {
    const { folded } = args;
    if (
      !jointControlsAgree(folded, args.counter, args.pages) ||
      !jointControlsAgree(folded, trendTotals(args.trend))
    )
      return undefined;
    return { sources: folded.sources, events: folded.events, dimensions: folded.dimensions };
  } catch {
    return undefined;
  }
}
