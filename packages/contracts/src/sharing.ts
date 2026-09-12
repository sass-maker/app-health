/** Public projection: intentionally excludes event names, paths, logs, keys and identities. */
export interface SharedAnalytics {
  project: { name: string; environment: string };
  live: { active: number | null; measured_at: number; ttl_ms: 45000 };
  traffic: {
    pageviews: number;
    from: number;
    to: number;
    series: { timestamp: number; pageviews: number }[];
  } | null;
  breakdowns?: {
    sessions: number;
    events: number;
    pages: { name: string; count: number }[];
    sources: { name: string; count: number }[];
  };
  source: 'local' | 'analytics-engine';
  sampled: boolean;
  updated_at: number;
}
export interface AnalyticsShare {
  id: string;
  app_id: string;
  environment_id: string;
  created_at: number;
  revoked_at: number | null;
  include_breakdowns: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBreakdowns(value: unknown): value is SharedAnalytics['breakdowns'] {
  if (!isRecord(value)) return false;
  const rows = (row: unknown) =>
    isRecord(row) && typeof row.name === 'string' && isNumber(row.count);
  return (
    isNumber(value.sessions) &&
    isNumber(value.events) &&
    Array.isArray(value.pages) &&
    value.pages.length <= 20 &&
    value.pages.every(rows) &&
    Array.isArray(value.sources) &&
    value.sources.length <= 20 &&
    value.sources.every(rows)
  );
}

function projectBreakdowns(value: NonNullable<SharedAnalytics['breakdowns']>) {
  return {
    sessions: value.sessions,
    events: value.events,
    pages: value.pages.map(({ name, count }) => ({ name, count })),
    sources: value.sources.map(({ name, count }) => ({ name, count })),
  };
}

function isProject(value: unknown): value is SharedAnalytics['project'] {
  return isRecord(value) && typeof value.name === 'string' && typeof value.environment === 'string';
}

function isLive(value: unknown): value is SharedAnalytics['live'] {
  return (
    isRecord(value) &&
    (value.active === null || isNumber(value.active)) &&
    isNumber(value.measured_at) &&
    value.ttl_ms === 45000
  );
}

function isSeries(value: unknown): value is NonNullable<SharedAnalytics['traffic']>['series'] {
  return (
    Array.isArray(value) &&
    value.length <= 24 &&
    value.every(
      (row) =>
        isRecord(row) && isNumber(row.timestamp) && isNumber(row.pageviews) && row.pageviews >= 0,
    )
  );
}

function isTraffic(value: unknown): value is NonNullable<SharedAnalytics['traffic']> {
  return (
    isRecord(value) &&
    isNumber(value.pageviews) &&
    isNumber(value.from) &&
    isNumber(value.to) &&
    isSeries(value.series)
  );
}

export function parseSharedAnalytics(value: unknown): SharedAnalytics | null {
  if (!isRecord(value)) return null;
  const project = value.project;
  const live = value.live;
  const traffic = value.traffic;
  if (
    !isProject(project) ||
    !isLive(live) ||
    (traffic !== null && !isTraffic(traffic)) ||
    (value.source !== 'local' && value.source !== 'analytics-engine') ||
    typeof value.sampled !== 'boolean' ||
    !isNumber(value.updated_at) ||
    (value.breakdowns !== undefined && !isBreakdowns(value.breakdowns))
  ) {
    return null;
  }
  return {
    project: { name: project.name, environment: project.environment },
    live: { active: live.active, measured_at: live.measured_at, ttl_ms: live.ttl_ms },
    traffic:
      traffic === null
        ? null
        : {
            pageviews: traffic.pageviews as number,
            from: traffic.from as number,
            to: traffic.to as number,
            series: traffic.series.map((row) => ({
              timestamp: row.timestamp,
              pageviews: row.pageviews,
            })),
          },
    source: value.source,
    sampled: value.sampled,
    updated_at: value.updated_at,
    ...(value.breakdowns ? { breakdowns: projectBreakdowns(value.breakdowns) } : {}),
  };
}
