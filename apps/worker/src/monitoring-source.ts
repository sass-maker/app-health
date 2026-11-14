import { D1ControlPlane, type D1DatabaseLike } from './d1-adapter.js';

export interface MonitoringSource {
  appId: string;
  environmentId: string;
}

export interface MonitoringBindings {
  DB?: D1DatabaseLike;
  APP_HEALTH_SELF_BACKEND_KEY?: string;
  APP_HEALTH_SELF_APP_ID?: string;
  APP_HEALTH_SELF_ENVIRONMENT_ID?: string;
}
export async function resolveMonitoringSource(env: MonitoringBindings) {
  if (!env.DB || !env.APP_HEALTH_SELF_BACKEND_KEY) return null;
  const key = await new D1ControlPlane(env.DB).verifyKey(env.APP_HEALTH_SELF_BACKEND_KEY);
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
