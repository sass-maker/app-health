import { type BrowserReport, BrowserReportFilter } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';

import { reportWindow } from './browser-report-window.js';
export { queryBrowserReport } from './browser-report-query.js';

type Breakdown = 'audience' | 'acquisition' | 'technology';
const breakdownOf = (filter: BrowserReportFilter): Breakdown =>
  (filter as BrowserReportFilter & { breakdown?: Breakdown }).breakdown ?? 'audience';
const emptyDimensions = (): Record<string, Map<string, number>> => ({
  channels: new Map(),
  campaigns: new Map(),
  devices: new Map(),
  browsers: new Map(),
  countries: new Map(),
  entry_pages: new Map(),
});
function addDimension(map: Map<string, number>, value: string) {
  map.set(value, (map.get(value) ?? 0) + 1);
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
  includePrevious = true,
): BrowserReport {
  const batchList = [...batches];
  const { from, to, step } = reportWindow(filter, now);
  const series = Array.from({ length: 24 }, (_, i) => ({
    timestamp: from + i * step,
    pageviews: 0,
    events: 0,
  }));
  const pages = new Map<string, number>();
  const sources = new Map<string, number>();
  const events = new Map<string, { name: string; count: number; last_seen: number }>();
  const sessions = new Set<string>();
  const visitors = new Set<string>();
  const newSessions = new Set<string>();
  const returningSessions = new Set<string>();
  const dimensions = emptyDimensions();
  const breakdown = breakdownOf(filter);
  for (const batch of batchList) {
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
          batch.attribution?.source || event.referrer || 'Direct / unknown',
          (sources.get(batch.attribution?.source || event.referrer || 'Direct / unknown') ?? 0) + 1,
        );
      }
      if (event.name) {
        const row = events.get(event.name) ?? { name: event.name, count: 0, last_seen: 0 };
        row.count++;
        row.last_seen = Math.max(row.last_seen, event.timestamp);
        events.set(event.name, row);
      }
      if (batch.session_hash) sessions.add(batch.session_hash);
      if (batch.visitor_hash) visitors.add(batch.visitor_hash);
      if (batch.session_hash && batch.visit_type === 'new') newSessions.add(batch.session_hash);
      if (batch.session_hash && batch.visit_type === 'returning')
        returningSessions.add(batch.session_hash);
      if (event.type === 'pageview' || filter.event) {
        const channel = batch.metadata?.channel;
        const entry = batch.attribution?.entry_path ?? event.path;
        if (breakdown === 'audience') {
          if (channel) addDimension(dimensions.channels, channel);
          addDimension(dimensions.entry_pages, entry);
        } else if (breakdown === 'acquisition') {
          const campaign = batch.attribution?.campaign;
          if (campaign) addDimension(dimensions.campaigns, campaign);
          const source = channel || 'Direct / unknown';
          addDimension(dimensions.channels, source);
        } else {
          if (batch.metadata?.device) addDimension(dimensions.devices, batch.metadata.device);
          if (batch.metadata?.browser) addDimension(dimensions.browsers, batch.metadata.browser);
          if (batch.metadata?.country) addDimension(dimensions.countries, batch.metadata.country);
        }
      }
    }
  }
  const dimensionCounts = Object.fromEntries(
    Object.entries(dimensions).map(([key, values]) => [key, rank(values)]),
  ) as Record<string, { name: string; count: number }[]>;
  const unidentified = Math.max(0, sessions.size - newSessions.size - returningSessions.size);
  const report = {
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
    sessions: sessions.size,
    audience: {
      visitors: visitors.size,
      new_sessions: newSessions.size,
      returning_sessions: returningSessions.size,
      unidentified_sessions: unidentified,
      ...dimensionCounts,
    } as NonNullable<BrowserReport['audience']>,
  } as BrowserReport;
  if (includePrevious) {
    const previous = localBrowserReport(batchList, filter, from, false);
    report.previous = {
      pageviews: previous.series.reduce((sum, row) => sum + row.pageviews, 0),
      events: previous.series.reduce((sum, row) => sum + row.events, 0),
      sessions: previous.sessions,
      visitors: previous.audience?.visitors ?? 0,
    };
  }
  return report;
}
