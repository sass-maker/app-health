import type { D1DatabaseLike } from './d1-adapter.js';

/** Deployment-wide webhooks belong to the legacy operator, never account workspaces. */
export async function legacyLogAlertsAllowed(
  db: D1DatabaseLike | undefined,
  appId: string,
): Promise<boolean> {
  if (!db) return true;
  try {
    const accounts = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_apps'")
      .first();
    if (!accounts) return true;
    const owner = await db
      .prepare('SELECT workspace_id FROM workspace_apps WHERE app_id = ?')
      .bind(appId)
      .first();
    return owner === null;
  } catch {
    return false;
  }
}
