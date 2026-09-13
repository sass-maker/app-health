import type { BrowserEngagement } from '@app-health/contracts';

export type EngagementSession = {
  pageviews: number;
  first: number;
  last: number;
  exit?: string;
  exit_timestamp?: number;
};

export function recordEngagementEvent(
  sessions: Map<string, EngagementSession>,
  key: string,
  event: { timestamp: number; type: 'pageview' | 'event'; path: string },
) {
  const session = sessions.get(key) ?? {
    pageviews: 0,
    first: event.timestamp,
    last: event.timestamp,
  };
  session.first = Math.min(session.first, event.timestamp);
  session.last = Math.max(session.last, event.timestamp);
  if (event.type === 'pageview') {
    session.pageviews++;
    if (
      session.exit === undefined ||
      event.timestamp > (session.exit_timestamp ?? -1) ||
      (event.timestamp === session.exit_timestamp && event.path.localeCompare(session.exit!) > 0)
    ) {
      session.exit = event.path;
      session.exit_timestamp = event.timestamp;
    }
  }
  sessions.set(key, session);
}

export function summarizeEngagement(
  sessions: Iterable<EngagementSession>,
  rank: (counts: Map<string, number>) => { name: string; count: number }[],
): BrowserEngagement {
  const pageviewSessions = [...sessions].filter((session) => session.pageviews > 0);
  const exits = new Map<string, number>();
  for (const session of pageviewSessions)
    if (session.exit) exits.set(session.exit, (exits.get(session.exit) ?? 0) + 1);
  const totalPageviews = pageviewSessions.reduce((sum, session) => sum + session.pageviews, 0);
  const bounced = pageviewSessions.filter((session) => session.pageviews === 1).length;
  return {
    pages_per_session: pageviewSessions.length ? totalPageviews / pageviewSessions.length : null,
    bounce_rate: pageviewSessions.length ? bounced / pageviewSessions.length : null,
    average_session_duration_ms: pageviewSessions.length
      ? pageviewSessions.reduce((sum, session) => sum + session.last - session.first, 0) /
        pageviewSessions.length
      : null,
    exit_pages: rank(exits),
  };
}
