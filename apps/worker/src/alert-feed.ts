import type { D1DatabaseLike } from './d1-adapter.js';
import type { LogLevel, LogSource } from '@app-health/contracts';

const ALERT_FEED_LIMIT = 50;
const RETENTION_MS = 30 * 86_400_000;
const PROBE_LOCATION_LIMIT = 10;
/** A probe location is stale after this many missed scheduled runs. */
const PROBE_STALE_RUNS = 3;
const DEFAULT_PROBE_INTERVAL_S = 300;

interface OwnerAlert {
  id: string;
  app_id: string;
  catalog_id: string;
  project_name: string;
  event: string;
  level: LogLevel;
  source: LogSource;
  timestamp: number;
  /** Synthetic journey incidents only: the probed journey and probe location. */
  journey?: string;
  location?: string;
}

/** Last heartbeat from one synthetic journey probe location. */
interface ProbeCoverage {
  location: string;
  last_seen_at: number;
  interval_seconds: number;
  state: 'fresh' | 'stale';
}

export interface OwnerAlertFeed {
  generated_at: number;
  total_count: number;
  entries: OwnerAlert[];
  /** Every probe location seen in retention; an empty list means no probe coverage. */
  probes: ProbeCoverage[];
}

function probeStatement(db: D1DatabaseLike, workspaceId: string, from: number, now: number) {
  // SQLite returns the bare interval column from the row holding MAX(timestamp).
  return db
    .prepare(
      `SELECT json_extract(l.props, '$.location') AS location, MAX(l.timestamp) AS last_seen_at,
        json_extract(l.props, '$.interval_seconds') AS interval_seconds
       FROM log_events l
       JOIN environments e ON e.id = l.environment_id AND e.app_id = l.app_id
         AND lower(e.name) = 'production'
       WHERE l.event = 'probe.heartbeat' AND l.timestamp >= ? AND l.timestamp <= ?
         AND json_extract(l.props, '$.location') IS NOT NULL
         AND l.app_id IN (SELECT source.app_id FROM catalog_project_imports source
           WHERE source.workspace_id = ? AND source.lifecycle IN ('primary', 'active'))
       GROUP BY location
       ORDER BY location
       LIMIT ?`,
    )
    .bind(from, now, workspaceId, PROBE_LOCATION_LIMIT);
}

function probeCoverage(row: Record<string, unknown>, now: number): ProbeCoverage {
  const interval = Number(row.interval_seconds);
  const intervalSeconds =
    Number.isFinite(interval) && interval >= 60 ? Math.floor(interval) : DEFAULT_PROBE_INTERVAL_S;
  const lastSeenAt = Math.max(0, Math.floor(Number(row.last_seen_at)));
  return {
    location: String(row.location),
    last_seen_at: lastSeenAt,
    interval_seconds: intervalSeconds,
    state: now - lastSeenAt > PROBE_STALE_RUNS * intervalSeconds * 1000 ? 'stale' : 'fresh',
  };
}

function journeyFields(row: Record<string, unknown>): Pick<OwnerAlert, 'journey' | 'location'> {
  if (typeof row.journey !== 'string' || typeof row.location !== 'string') return {};
  return { journey: row.journey, location: row.location };
}

/**
 * Read recent production errors, degradation and response receipts for one
 * workspace. Submitted text, email and arbitrary log properties are never returned.
 */
export async function readOwnerAlertFeed(
  db: D1DatabaseLike,
  workspaceId: string,
  now = Date.now(),
  requestedLimit = ALERT_FEED_LIMIT,
): Promise<OwnerAlertFeed> {
  const limit = Math.max(1, Math.min(ALERT_FEED_LIMIT, Math.floor(requestedLimit)));
  const scope = `FROM log_events l
    JOIN environments e ON e.id = l.environment_id AND e.app_id = l.app_id
      AND lower(e.name) = 'production'
    JOIN catalog_project_imports c
      ON c.workspace_id = ? AND c.lifecycle IN ('primary', 'active')
    WHERE (l.event IN ('feedback.submitted', 'waitlist.join', 'newsletter.subscribe',
        'journey.recovered')
      OR l.level = 'error'
      OR (l.level = 'warn' AND l.event LIKE '%.degraded'))
      AND l.timestamp >= ? AND l.timestamp <= ?
      AND EXISTS (SELECT 1 FROM catalog_project_imports source
        WHERE source.workspace_id = ? AND source.app_id = l.app_id
          AND source.lifecycle IN ('primary', 'active'))
      AND c.catalog_id = COALESCE(
        (SELECT by_id.catalog_id FROM catalog_project_imports by_id
          WHERE by_id.workspace_id = ? AND by_id.lifecycle IN ('primary', 'active')
            AND by_id.catalog_id = json_extract(l.props, '$.project_id') LIMIT 1),
        (SELECT by_slug.catalog_id FROM catalog_project_imports by_slug
          WHERE by_slug.workspace_id = ? AND by_slug.lifecycle IN ('primary', 'active')
            AND by_slug.catalog_id = json_extract(l.props, '$.project') LIMIT 1),
        CASE WHEN NULLIF(json_extract(l.props, '$.project_id'), '') IS NULL
              AND NULLIF(json_extract(l.props, '$.project'), '') IS NULL
          THEN c.catalog_id ELSE NULL END
      )
      AND (
        (NULLIF(json_extract(l.props, '$.project_id'), '') IS NULL
          AND NULLIF(json_extract(l.props, '$.project'), '') IS NULL
          AND c.app_id = l.app_id)
        OR c.catalog_id = json_extract(l.props, '$.project_id')
        OR c.catalog_id = json_extract(l.props, '$.project')
      )`;
  const from = Math.max(0, now - RETENTION_MS);
  const binds = [workspaceId, from, now, workspaceId, workspaceId, workspaceId];
  const countStatement = db.prepare(`SELECT COUNT(*) AS total_count ${scope}`).bind(...binds);
  const entriesStatement = db
    .prepare(
      `SELECT l.log_id AS id, l.app_id AS app_id, c.catalog_id AS catalog_id,
        c.catalog_name AS project_name, l.event AS event, l.level AS level,
        l.source AS source, l.timestamp AS timestamp,
        CASE WHEN l.event LIKE 'journey.%' THEN json_extract(l.props, '$.journey') END AS journey,
        CASE WHEN l.event LIKE 'journey.%' THEN json_extract(l.props, '$.location') END AS location
       ${scope}
       ORDER BY l.timestamp DESC, l.log_id DESC
       LIMIT ?`,
    )
    .bind(...binds, limit);
  const results = await db.batch([
    countStatement,
    entriesStatement,
    probeStatement(db, workspaceId, from, now),
  ]);
  const countRows = results[0]?.results;
  const rows = results[1]?.results;
  const probeRows = results[2]?.results;
  if (
    results.length !== 3 ||
    results.some((result) => !result.success) ||
    !Array.isArray(countRows) ||
    countRows.length !== 1 ||
    !Array.isArray(rows) ||
    !Array.isArray(probeRows)
  ) {
    throw new Error('D1 alert feed read failed');
  }
  const countRow = countRows[0];

  return {
    generated_at: now,
    total_count: Math.max(0, Math.floor(Number(countRow?.total_count ?? 0))),
    entries: rows.map((row) => ({
      id: String(row.id),
      app_id: String(row.app_id),
      catalog_id: String(row.catalog_id),
      project_name: String(row.project_name),
      event: String(row.event),
      level: row.level as LogLevel,
      source: row.source as LogSource,
      timestamp: Math.max(0, Math.floor(Number(row.timestamp))),
      ...journeyFields(row),
    })),
    probes: probeRows.map((row) => probeCoverage(row, now)),
  };
}
