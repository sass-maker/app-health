import type { D1DatabaseLike } from './d1-adapter.js';
import type { CatalogMetadata } from '@app-health/contracts';

export const catalogInventoryJoin = `LEFT JOIN workspace_portfolio_snapshots portfolio ON portfolio.workspace_id = w.id
LEFT JOIN current_workspace_catalog current_catalog ON current_catalog.workspace_id = w.id AND current_catalog.app_id = a.id`;
export const catalogInventoryColumns = `CASE WHEN portfolio.workspace_id IS NULL OR current_catalog.app_id IS NOT NULL THEN 1 ELSE 0 END AS portfolio_visible,
CASE WHEN portfolio.workspace_id IS NOT NULL THEN current_catalog.catalog_name ELSE a.name END AS portfolio_name,
CASE WHEN portfolio.workspace_id IS NOT NULL THEN current_catalog.catalog_id END AS catalog_id,
current_catalog.kind AS catalog_kind, current_catalog.future_form AS catalog_future_form, current_catalog.auth_model AS catalog_auth_model`;
export interface CatalogInventoryRow {
  portfolio_visible: number;
  portfolio_name: string | null;
  catalog_id: string | null;
  catalog_kind: string | null;
  catalog_future_form: string | null;
  catalog_auth_model: string | null;
}
export function inventoryCatalog(row: CatalogInventoryRow): { catalog?: CatalogMetadata } {
  return row.catalog_id && row.catalog_kind && row.catalog_future_form && row.catalog_auth_model
    ? {
        catalog: {
          source: 'saas-maker',
          catalog_id: row.catalog_id,
          kind: row.catalog_kind,
          future_form: row.catalog_future_form,
          auth_model: row.catalog_auth_model,
        },
      }
    : {};
}

export function portfolioInventoryPredicate(workspace: string, app: string) {
  return `(NOT EXISTS (SELECT 1 FROM workspace_portfolio_snapshots selected_snapshot WHERE selected_snapshot.workspace_id = ${workspace}) OR EXISTS (SELECT 1 FROM current_workspace_catalog selected_project WHERE selected_project.workspace_id = ${workspace} AND selected_project.app_id = ${app}))`;
}

export interface PortfolioAnalyticsSnapshot {
  appIds: readonly string[];
  projectionHash: string;
}

/** Read the active roster and its cache revision from the same catalog row. */
export async function currentPortfolioAnalyticsSnapshot(
  db: D1DatabaseLike | undefined,
  workspace: string,
  owned: readonly string[],
): Promise<PortfolioAnalyticsSnapshot> {
  const snapshot = await db
    ?.prepare(
      'SELECT projects_json, projection_hash FROM workspace_portfolio_snapshots WHERE workspace_id = ?',
    )
    .bind(workspace)
    .first<{ projects_json: string; projection_hash: string }>();
  if (!snapshot) return { appIds: owned, projectionHash: 'manual' };
  const selected = new Set(
    (JSON.parse(snapshot.projects_json) as { app_id: string }[]).map((project) => project.app_id),
  );
  return {
    appIds: owned.filter((app) => selected.has(app)),
    projectionHash: snapshot.projection_hash,
  };
}
