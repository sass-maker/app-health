import type { CatalogImportRequest } from '@app-health/contracts';
import type { D1DatabaseLike, D1PreparedStatement } from './d1-adapter.js';

export class CatalogImportConflict extends Error {}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An import declares metadata; it cannot claim a legacy project or enable ingest. */
export async function importCatalogProjects(
  db: D1DatabaseLike,
  workspace: string,
  input: CatalogImportRequest,
  now: number,
) {
  const statements: D1PreparedStatement[] = [];
  const imported: { catalog_id: string; app_id: string; verification_state: 'declared' }[] = [];
  for (const project of input.projects) {
    const identity = await hash(JSON.stringify([workspace, project.catalog_id]));
    const app = project.existing_app_id ?? `app-import-${identity}`;
    const environment = `env-import-${identity}`;
    if (!project.existing_app_id) {
      statements.push(
        db
          .prepare('INSERT OR IGNORE INTO apps (id, name, created_at) VALUES (?, ?, ?)')
          .bind(app, project.name, now),
        db
          .prepare('INSERT OR IGNORE INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
          .bind(app, workspace),
        db
          .prepare(
            'INSERT OR IGNORE INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)',
          )
          .bind(environment, app, 'production', now),
        db
          .prepare(
            'INSERT OR IGNORE INTO installation_status (app_id, environment_id, runtime, first_seen, last_seen) VALUES (?, ?, NULL, NULL, NULL)',
          )
          .bind(app, environment),
      );
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO catalog_project_imports
      (workspace_id, catalog_id, catalog_name, app_id, repository, hostname, lifecycle, payload_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, catalog_id) DO UPDATE SET payload_sha256 = excluded.payload_sha256`,
        )
        .bind(
          workspace,
          project.catalog_id,
          project.name,
          app,
          project.repository,
          project.hostname,
          project.lifecycle,
          await hash(JSON.stringify(project)),
          now,
        ),
    );
    imported.push({ catalog_id: project.catalog_id, app_id: app, verification_state: 'declared' });
  }
  try {
    const results = await db.batch(statements);
    if (results.some((result) => !result.success))
      throw new Error('Catalog import transaction failed');
  } catch (error) {
    if (
      error instanceof Error &&
      /catalog import (project scope mismatch|identity conflict)|UNIQUE constraint failed: catalog_project_imports/.test(
        error.message,
      )
    )
      throw new CatalogImportConflict('Catalog identity conflict or project access denied');
    throw error;
  }
  return { schema_version: 1, projects: imported };
}
