import {
  MonitoringPolicyV1,
  MonitoringReportV1,
  type MonitoringPolicy,
  type MonitoringReport,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import { readPublicJson } from './public-body.js';

type Project = MonitoringReport['projects'][number];
type Check = Project['checks'][number];
type Observation = Check['observations'][number];
type MonitoringScope = { appId: string; environmentId: string };
const RETENTION_MS = 30 * 86400000;
const MAX_OBSERVATIONS = 6000;
const failures = new Set([
  'dns',
  'connect',
  'tls',
  'network',
  'timeout',
  'incomplete',
  'body_too_large',
  'http',
  'content_type',
  'parse',
  'semantic',
  'asset',
]);
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function saveMonitoringPolicy(
  db: D1DatabaseLike,
  workspaceId: string,
  policy: MonitoringPolicy,
  now: number,
): Promise<void> {
  const revision = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare('DELETE FROM workspace_monitoring_projects WHERE workspace_id = ?')
      .bind(workspaceId),
    ...policy.projects.map((row) =>
      db
        .prepare(
          `INSERT INTO workspace_monitoring_projects
        (workspace_id, catalog_id, name, scope, reason, journeys_json, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          workspaceId,
          row.catalog_id,
          row.name,
          row.scope,
          row.reason,
          JSON.stringify(row.journeys),
          now,
          revision,
        ),
    ),
  ]);
  if (results.length !== policy.projects.length + 1 || results.some((result) => !result.success))
    throw new Error('Monitoring policy transaction failed');
}

function observation(row: Record<string, unknown>, now: number): Observation | null {
  const interval = Number(row.interval_seconds);
  const lastSeen = Number(row.timestamp);
  const location = String(row.location ?? '');
  const health = row.health;
  if (
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(location) ||
    !Number.isSafeInteger(interval) ||
    interval < 60 ||
    interval > 86400 ||
    !Number.isSafeInteger(lastSeen) ||
    lastSeen < 0 ||
    lastSeen > now ||
    !['healthy', 'degraded', 'failing'].includes(String(health))
  )
    return null;
  const freshness =
    now - lastSeen > interval * 3000
      ? 'stale'
      : Number(row.vantage_offline) === 1
        ? 'offline'
        : 'fresh';
  return {
    location,
    last_seen_at: lastSeen,
    interval_seconds: interval,
    freshness,
    health: freshness === 'fresh' ? (health as Observation['health']) : null,
    failure: failures.has(String(row.failure)) ? String(row.failure) : null,
    total_ms:
      typeof row.total_ms === 'number' && Number.isFinite(row.total_ms) && row.total_ms >= 0
        ? row.total_ms
        : null,
  };
}

function worstHealth(observations: Observation[]): Check['health'] {
  const fresh = observations.filter((row) => row.freshness === 'fresh');
  return fresh.some((row) => row.health === 'failing')
    ? 'failing'
    : fresh.some((row) => row.health === 'degraded')
      ? 'degraded'
      : fresh.length
        ? 'healthy'
        : null;
}

function checkState(journey: string, observations: Observation[]): Check {
  return {
    journey,
    freshness: observations.some((row) => row.freshness === 'fresh')
      ? 'fresh'
      : observations.some((row) => row.freshness === 'offline')
        ? 'offline'
        : observations.length
          ? 'stale'
          : 'missing',
    health: worstHealth(observations),
    observations,
  };
}

function projectState(project: Omit<Project, 'state'>): Project['state'] {
  if (project.scope !== 'public') return project.scope;
  if (!project.app_id || !project.environment_id) return 'unconfigured';
  if (!project.checks.length) return 'missing';
  if (project.checks.some((check) => check.health === 'failing')) return 'failing';
  if (project.checks.some((check) => check.health === 'degraded')) return 'degraded';
  if (project.checks.some((check) => check.freshness === 'missing')) return 'missing';
  if (project.checks.some((check) => check.freshness === 'offline')) return 'offline';
  if (project.checks.some((check) => check.freshness === 'stale')) return 'stale';
  return 'healthy';
}

export async function readMonitoringReport(
  db: D1DatabaseLike,
  workspaceId: string,
  now: number,
  scope?: MonitoringScope,
): Promise<MonitoringReport> {
  const selected = scope ? 'AND c.app_id = ? AND e.id = ?' : '';
  const selectedBinds = scope ? [scope.appId, scope.environmentId] : [];
  const results = await db.batch([
    db
      .prepare(
        `SELECT p.catalog_id, p.name, p.scope, p.reason, p.journeys_json, p.updated_at,
        c.app_id, e.id AS environment_id
      FROM workspace_monitoring_projects p
      LEFT JOIN catalog_project_imports c ON c.workspace_id = p.workspace_id
        AND c.catalog_id = p.catalog_id AND c.lifecycle IN ('primary', 'active')
        AND EXISTS (SELECT 1 FROM workspace_apps wa JOIN apps a ON a.id = wa.app_id
          WHERE wa.workspace_id = p.workspace_id AND wa.app_id = c.app_id AND a.archived_at IS NULL)
      LEFT JOIN environments e ON e.app_id = c.app_id AND lower(e.name) = 'production'
      WHERE p.workspace_id = ? ${selected}
      ORDER BY p.name, p.catalog_id LIMIT 61`,
      )
      .bind(workspaceId, ...selectedBinds),
    db
      .prepare(
        `WITH latest AS (
      SELECT p.catalog_id, json_extract(l.props, '$.journey') AS journey,
        json_extract(l.props, '$.location') AS location, l.timestamp,
        json_extract(l.props, '$.status') AS health,
        json_extract(l.props, '$.interval_seconds') AS interval_seconds,
        json_extract(l.props, '$.vantage_offline') AS vantage_offline,
        json_extract(l.props, '$.failure') AS failure,
        json_extract(l.props, '$.total_ms') AS total_ms,
        ROW_NUMBER() OVER (PARTITION BY p.catalog_id, json_extract(l.props, '$.journey'),
          json_extract(l.props, '$.location') ORDER BY l.timestamp DESC, l.log_id DESC) AS rank
      FROM workspace_monitoring_projects p
      JOIN catalog_project_imports c ON c.workspace_id = p.workspace_id
        AND c.catalog_id = p.catalog_id AND c.lifecycle IN ('primary', 'active')
      JOIN workspace_apps target ON target.app_id = c.app_id AND target.workspace_id = p.workspace_id
      JOIN apps a ON a.id = target.app_id AND a.archived_at IS NULL
      JOIN environments e ON e.app_id = c.app_id AND lower(e.name) = 'production'
      JOIN log_events l ON json_extract(l.props, '$.project') = p.catalog_id
      JOIN environments source_env ON source_env.id = l.environment_id
        AND source_env.app_id = l.app_id AND lower(source_env.name) = 'production'
      WHERE p.workspace_id = ? ${selected}
        AND l.event = 'probe.result' AND l.source = 'server'
        AND l.timestamp >= ? AND l.timestamp <= ?
        AND EXISTS (SELECT 1 FROM workspace_apps sender
          WHERE sender.workspace_id = p.workspace_id AND sender.app_id = l.app_id)
        AND EXISTS (SELECT 1 FROM json_each(p.journeys_json) expected
          WHERE expected.value = json_extract(l.props, '$.journey'))
    ) SELECT * FROM latest WHERE rank = 1 LIMIT ${MAX_OBSERVATIONS + 1}`,
      )
      .bind(workspaceId, ...selectedBinds, Math.max(0, now - RETENTION_MS), now),
  ]);
  if (results.length !== 2 || results.some((r) => !r.success || !Array.isArray(r.results)))
    throw new Error('Monitoring report read failed');
  const policyRows = results[0].results!;
  const receiptRows = results[1].results!;
  if (policyRows.length > 60 || receiptRows.length > MAX_OBSERVATIONS)
    throw new Error('Monitoring report capacity exceeded');
  const byCheck = new Map<string, Observation[]>();
  for (const row of receiptRows) {
    const value = observation(row, now);
    if (!value) continue;
    const key = JSON.stringify([row.catalog_id, row.journey]);
    const rows = byCheck.get(key) ?? [];
    rows.push(value);
    if (rows.length > 10) throw new Error('Monitoring location capacity exceeded');
    byCheck.set(key, rows);
  }
  const projects = policyRows.map((row): Project => {
    const project = {
      catalog_id: String(row.catalog_id),
      name: String(row.name),
      scope: row.scope as Project['scope'],
      reason: row.reason === null ? null : String(row.reason),
      journeys: JSON.parse(String(row.journeys_json)) as string[],
      app_id: row.app_id === null ? null : String(row.app_id),
      environment_id: row.environment_id === null ? null : String(row.environment_id),
    };
    const withChecks = {
      ...project,
      checks: project.journeys.map((journey) =>
        checkState(journey, byCheck.get(JSON.stringify([project.catalog_id, journey])) ?? []),
      ),
    };
    return { ...withChecks, state: projectState(withChecks) };
  });
  return MonitoringReportV1.parse({
    schema_version: 1,
    generated_at: now,
    policy_updated_at: policyRows.length
      ? Math.max(...policyRows.map((row) => Number(row.updated_at)))
      : null,
    projects,
  });
}

export async function handleMonitoringRoute(
  request: Request,
  db: D1DatabaseLike | undefined,
  owner: OwnerIdentity,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['/v1/workspace/monitoring', '/v1/workspace/monitoring/policy'].includes(url.pathname))
    return null;
  if (!owner.workspaceId || owner.appId) return json(403, { error: 'Workspace access required' });
  if (!db) return json(503, { error: 'Monitoring storage is unavailable' });
  try {
    if (url.pathname.endsWith('/policy')) {
      if (owner.authKind !== 'account' || owner.workspaceRole !== 'owner')
        return json(403, { error: 'Workspace owner access required' });
      if (request.method !== 'PUT') return json(405, { error: 'Use PUT' });
      let input: unknown;
      try {
        input = await readPublicJson(request, 65536);
      } catch {
        return json(400, { error: 'Invalid monitoring policy' });
      }
      const policy = MonitoringPolicyV1.safeParse(input);
      if (!policy.success) return json(400, { error: 'Invalid monitoring policy' });
      await saveMonitoringPolicy(db, owner.workspaceId, policy.data, Date.now());
      return json(200, {
        schema_version: 1,
        state: 'declared',
        project_count: policy.data.projects.length,
      });
    }
    if (request.method !== 'GET') return json(405, { error: 'Use GET' });
    const appId = url.searchParams.get('app_id');
    const environmentId = url.searchParams.get('environment_id');
    if (
      (appId === null) !== (environmentId === null) ||
      (appId !== null && (!appId || !environmentId)) ||
      url.searchParams.getAll('app_id').length > 1 ||
      url.searchParams.getAll('environment_id').length > 1
    )
      return json(400, { error: 'Select one project and environment together' });
    return json(
      200,
      await readMonitoringReport(
        db,
        owner.workspaceId,
        Date.now(),
        appId && environmentId ? { appId, environmentId } : undefined,
      ),
    );
  } catch {
    return json(503, { error: 'Monitoring is unavailable' });
  }
}
