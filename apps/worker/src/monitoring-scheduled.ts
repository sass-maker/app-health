import { Buffer } from 'node:buffer';
import { D1ControlPlane, type D1DatabaseLike } from './d1-adapter.js';
import { emptyState, runProbes, type ProbeState } from '../../probe/src/run.ts';
import { journeyKey, parseSpec } from '../../probe/src/spec.ts';
import type { HttpResult, Measure } from '../../probe/src/types.ts';
import type { ProbeLog } from '../../probe/src/emit.ts';
import generated from '../../probe/journeys.json';

interface Bindings {
  DB?: D1DatabaseLike;
  APP_HEALTH_SELF_BACKEND_KEY?: string;
  APP_HEALTH_SELF_APP_ID?: string;
  APP_HEALTH_SELF_ENVIRONMENT_ID?: string;
}
const INTERVAL_SECONDS = 3600;
const LEASE_MS = 45 * 60000;
const RUN_DEADLINE_MS = 10 * 60000;

export function workerMeasure(fetcher: typeof fetch, deadline: number): Measure {
  return async (request) => {
    const started = performance.now();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Monitoring run deadline exceeded');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(request.timeoutMs, 8000, remaining),
    );
    const phases: HttpResult['phases'] = { total_ms: 0 };
    let response: Response | undefined;
    try {
      response = await fetcher(request.url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': request.userAgent },
        signal: controller.signal,
      });
      phases.headers_ms = performance.now() - started;
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > request.maxBytes) {
            await reader.cancel();
            return { failure: 'body_too_large', phases: { total_ms: performance.now() - started } };
          }
          chunks.push(chunk.value);
        }
      phases.total_ms = performance.now() - started;
      phases.body_ms = phases.total_ms - phases.headers_ms;
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? undefined,
        body: Buffer.concat(chunks),
        phases,
      };
    } catch {
      return {
        failure: controller.signal.aborted ? 'timeout' : response ? 'incomplete' : 'network',
        phases: { ...phases, total_ms: performance.now() - started },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function monitoringTarget(env: Bindings, control: D1ControlPlane) {
  if (!env.DB || !env.APP_HEALTH_SELF_BACKEND_KEY) return null;
  const key = await control.verifyKey(env.APP_HEALTH_SELF_BACKEND_KEY);
  if (
    !key?.environment_id ||
    (env.APP_HEALTH_SELF_APP_ID && env.APP_HEALTH_SELF_APP_ID !== key.app_id) ||
    (env.APP_HEALTH_SELF_ENVIRONMENT_ID &&
      env.APP_HEALTH_SELF_ENVIRONMENT_ID !== key.environment_id)
  )
    return null;
  const target = await env.DB.prepare(
    `SELECT wa.workspace_id FROM workspace_apps wa
    JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL
    JOIN environments e ON e.app_id = a.id AND e.id = ? AND lower(e.name) = 'production'
    JOIN catalog_project_imports c ON c.workspace_id = wa.workspace_id AND c.app_id = a.id
      AND c.lifecycle IN ('primary', 'active')
    WHERE wa.app_id = ? LIMIT 1`,
  )
    .bind(key.environment_id, key.app_id)
    .first<{ workspace_id: string }>();
  return target
    ? {
        workspaceId: target.workspace_id,
        appId: key.app_id,
        environmentId: key.environment_id,
        keyId: key.id,
      }
    : null;
}

export async function runScheduledMonitoring(
  env: Bindings,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  if (!env.DB || !env.APP_HEALTH_SELF_BACKEND_KEY) return;
  const db = env.DB;
  const target = await monitoringTarget(env, new D1ControlPlane(db));
  if (!target) return;
  const policy = (
    await db
      .prepare(
        `SELECT p.catalog_id, p.journeys_json, p.revision
    FROM workspace_monitoring_projects p
    JOIN catalog_project_imports c ON c.workspace_id = p.workspace_id
      AND c.catalog_id = p.catalog_id AND c.lifecycle IN ('primary', 'active')
    JOIN workspace_apps wa ON wa.workspace_id = p.workspace_id AND wa.app_id = c.app_id
    JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL
    WHERE p.workspace_id = ? AND p.scope = 'public' LIMIT 61`,
      )
      .bind(target.workspaceId)
      .all<{ catalog_id: string; journeys_json: string; revision: string }>()
  ).results;
  if (!policy.length) return;
  if (policy.length > 60) throw new Error('Monitoring policy capacity exceeded');
  const allowed = new Set(
    policy.flatMap((row) =>
      (JSON.parse(row.journeys_json) as string[]).map((journey) => `${row.catalog_id}/${journey}`),
    ),
  );
  const spec = parseSpec(generated);
  spec.journeys = spec.journeys.filter((journey) => allowed.has(journeyKey(journey)));
  if (!spec.journeys.length) return;
  if (
    spec.journeys.length > 48 ||
    spec.journeys.some(
      (journey) => journey.method !== 'GET' || new URL(journey.url).protocol !== 'https:',
    )
  )
    throw new Error('Hosted monitoring policy exceeds public check bounds');
  const leaseId = crypto.randomUUID();
  const lease = await db
    .prepare(
      `INSERT INTO workspace_monitoring_runs
    (workspace_id, lease_id, lease_started_at, state_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET lease_id = excluded.lease_id,
      lease_started_at = excluded.lease_started_at, committed_lease_id = NULL
    WHERE workspace_monitoring_runs.lease_started_at <= ?
    RETURNING state_json`,
    )
    .bind(target.workspaceId, leaseId, now, JSON.stringify(emptyState()), now - LEASE_MS)
    .first<{ state_json: string }>();
  if (!lease) return;
  const previous = JSON.parse(lease.state_json) as ProbeState;
  const keys = new Set(spec.journeys.map(journeyKey));
  previous.journeys = Object.fromEntries(
    Object.entries(previous.journeys).filter(([key]) => keys.has(key)),
  );
  previous.pending = [];
  let logs: ProbeLog[] = [];
  const result = await runProbes(
    spec,
    previous,
    {
      location: 'cloudflare-hourly',
      intervalSeconds: INTERVAL_SECONDS,
      userAgent: 'AppHealthJourneyProbe/1 (+https://health.sassmaker.com)',
    },
    {
      measure: workerMeasure(fetcher, Date.now() + RUN_DEADLINE_MS),
      deliver: async (batch) => {
        logs = batch;
        return true;
      },
      now: () => now,
      uuid: () => crypto.randomUUID(),
    },
  );
  const statements = logs.map((log) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO log_events
    (log_id, app_id, environment_id, timestamp, event, level, title, props, source)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'server' FROM workspace_monitoring_runs
    WHERE workspace_id = ? AND lease_id = ? AND committed_lease_id = ?`,
      )
      .bind(
        log.log_id,
        target.appId,
        target.environmentId,
        log.timestamp,
        log.event,
        log.level,
        log.title,
        JSON.stringify(log.props),
        target.workspaceId,
        leaseId,
        leaseId,
      ),
  );
  statements.unshift(
    db
      .prepare(
        `UPDATE workspace_monitoring_runs SET committed_lease_id = ?
    WHERE workspace_id = ? AND lease_id = ?
      AND EXISTS (SELECT 1 FROM keys k
        JOIN workspace_apps wa ON wa.app_id = k.app_id AND wa.workspace_id = ?
        JOIN apps a ON a.id = wa.app_id AND a.archived_at IS NULL
        JOIN environments e ON e.id = k.environment_id AND e.app_id = k.app_id
          AND lower(e.name) = 'production'
        JOIN catalog_project_imports c ON c.workspace_id = wa.workspace_id AND c.app_id = a.id
          AND c.lifecycle IN ('primary', 'active')
        WHERE k.id = ? AND k.app_id = ? AND k.environment_id = ? AND k.revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM workspace_monitoring_projects p
        WHERE p.workspace_id = ? AND p.revision = ?)`,
      )
      .bind(
        leaseId,
        target.workspaceId,
        leaseId,
        target.workspaceId,
        target.keyId,
        target.appId,
        target.environmentId,
        target.workspaceId,
        policy[0].revision,
      ),
  );
  statements.push(
    db
      .prepare(
        `UPDATE workspace_monitoring_runs SET state_json = ?
    WHERE workspace_id = ? AND lease_id = ? AND committed_lease_id = ?`,
      )
      .bind(JSON.stringify(result.state), target.workspaceId, leaseId, leaseId),
  );
  const written = await db.batch(statements);
  if (
    written.length !== statements.length ||
    written.some((row) => !row.success) ||
    written[0]?.meta.changes !== 1 ||
    written.at(-1)?.meta.changes !== 1
  )
    throw new Error('Monitoring run commit failed');
}
