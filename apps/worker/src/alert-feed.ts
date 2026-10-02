import type { D1DatabaseLike } from './d1-adapter.js';

const ALERT_FEED_LIMIT = 50;
const RETENTION_MS = 30 * 86_400_000;

interface OwnerAlert {
  id: string;
  app_id: string;
  catalog_id: string;
  project_name: string;
  event: 'feedback.submitted' | 'waitlist.join' | 'newsletter.subscribe';
  timestamp: number;
}

export interface OwnerAlertFeed {
  generated_at: number;
  total_count: number;
  entries: OwnerAlert[];
}

/**
 * Read the latest owner-authored feedback, waitlist, and newsletter alert metadata for one
 * workspace. Submitted text, email, props, and other log fields are never read.
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
    WHERE l.event IN ('feedback.submitted', 'waitlist.join', 'newsletter.subscribe')
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
        c.catalog_name AS project_name, l.event AS event, l.timestamp AS timestamp
       ${scope}
       ORDER BY l.timestamp DESC, l.log_id DESC
       LIMIT ?`,
    )
    .bind(...binds, limit);
  const results = await db.batch([countStatement, entriesStatement]);
  const countRows = results[0]?.results;
  const rows = results[1]?.results;
  if (
    results.length !== 2 ||
    results.some((result) => !result.success) ||
    !Array.isArray(countRows) ||
    countRows.length !== 1 ||
    !Array.isArray(rows)
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
      event: row.event as OwnerAlert['event'],
      timestamp: Math.max(0, Math.floor(Number(row.timestamp))),
    })),
  };
}
