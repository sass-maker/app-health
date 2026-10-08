import type { BrowserBatchV1 } from '@app-health/contracts';
import type { AnalyticsEngineDatasetLike } from './analytics-engine.js';

/**
 * Lightweight retained counters for browser batches rejected as known bots.
 *
 * Bot rows share the browser dataset but never use a workspace index, so every
 * existing `index1 = <workspace>` report keeps excluding them. Each rejected
 * batch writes one point: app, environment, source and bot class, with
 * pageview/other-event counts. No path, session, visitor or metadata persists.
 */
const BOT_COUNTER_KIND = 'bot_batch';
/** Hourly Cron proof that the deployed collector retains bot counters. */
export const BOT_COUNTER_HEARTBEAT_INDEX = 'bot-counter-heartbeat';
const AE_INDEX_MAX_BYTES = 96;
const SOURCE_MAX = 100;

function botCounterIndex(appId: string): string {
  return `bot:${appId}`;
}

type BotClass = 'verified' | 'user_agent';

export function writeBotCounter(
  dataset: AnalyticsEngineDatasetLike | undefined,
  scope: { app_id: string; environment_id: string },
  input: Pick<BrowserBatchV1, 'events' | 'attribution'>,
  botClass: BotClass,
  receivedAt: number,
): void {
  if (!dataset || input.events.length === 0) return;
  const index = botCounterIndex(scope.app_id);
  if (new TextEncoder().encode(index).length > AE_INDEX_MAX_BYTES) return;
  const pageviews = input.events.filter((event) => event.type === 'pageview').length;
  const source = (
    input.attribution ? input.attribution.source : (input.events[0]?.referrer ?? '')
  ).slice(0, SOURCE_MAX);
  try {
    dataset.writeDataPoint({
      indexes: [index],
      blobs: [scope.app_id, scope.environment_id, BOT_COUNTER_KIND, source, botClass],
      doubles: [pageviews, receivedAt, input.events.length - pageviews],
    });
  } catch {
    // Counters are auxiliary; a failed write must not change the bot response.
    console.warn(JSON.stringify({ event: 'browser_bot_counter_failed' }));
  }
}

export function writeBotCounterHeartbeat(
  dataset: AnalyticsEngineDatasetLike | undefined,
  now: number,
): void {
  if (!dataset) return;
  try {
    dataset.writeDataPoint({
      indexes: [BOT_COUNTER_HEARTBEAT_INDEX],
      blobs: ['heartbeat'],
      doubles: [1, now],
    });
  } catch {
    console.warn(JSON.stringify({ event: 'browser_bot_counter_heartbeat_failed' }));
  }
}

const HOUR_MS = 3_600_000;
/** A day has ~28 hourly beats across its ±2h margin; tolerate a few missed runs. */
const MIN_DAY_HEARTBEATS = 24;

export function botCounterCoverageSql(from: number, to: number): string {
  return `SELECT MIN(double2) AS first_seen, MAX(double2) AS last_seen, COUNT() AS beats
    FROM app_health_browser_v1 WHERE index1 = '${BOT_COUNTER_HEARTBEAT_INDEX}'
    AND double2 >= ${from - 2 * HOUR_MS} AND double2 < ${to + 2 * HOUR_MS}`;
}

/** Bot counts are known only when the counting collector ran across the whole day. */
export function botCountersCoverDay(rows: unknown[], from: number, to: number): boolean {
  const row = rows[0] as { first_seen?: unknown; last_seen?: unknown; beats?: unknown } | undefined;
  if (rows.length !== 1 || !row) return false;
  const first = Number(row.first_seen);
  const last = Number(row.last_seen);
  const beats = Number(row.beats);
  return (
    Number.isFinite(first) &&
    Number.isFinite(last) &&
    first > 0 &&
    first <= from &&
    last >= to &&
    beats >= MIN_DAY_HEARTBEATS
  );
}

export function botSourceAggregateSql(
  appIds: readonly string[],
  environments: string,
  from: number,
  to: number,
  limit: number,
): string {
  const indexes = appIds.map((id) => `'${botCounterIndex(id).replaceAll("'", "''")}'`).join(',');
  return `SELECT 1 AS period, 'source' AS kind, blob1 AS app_id, substring(lower(blob4),1,${SOURCE_MAX}) AS name,
      SUM(double1 * _sample_interval) AS pageviews, 0 AS visitors, MAX(_sample_interval) AS sample_interval
      FROM app_health_browser_v1 WHERE index1 IN (${indexes}) AND blob3 = '${BOT_COUNTER_KIND}'
      AND double2 >= ${from} AND double2 < ${to} AND blob2 IN (${environments})
      GROUP BY app_id, name LIMIT ${limit + 1}`;
}
