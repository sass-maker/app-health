import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

/** Add migration 0043 to minimal older test schemas, preserving their synthetic rows. */
export function portfolioFixture(sqlite: DatabaseSync) {
  sqlite.exec('CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY)');
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS catalog_project_imports (workspace_id TEXT, catalog_id TEXT, app_id TEXT, catalog_name TEXT, lifecycle TEXT)',
  );
  const columns = new Set(
    sqlite
      .prepare('PRAGMA table_info(catalog_project_imports)')
      .all()
      .map((row) => row.name),
  );
  for (const name of ['catalog_id', 'catalog_name', 'repository', 'hostname', 'verification_state'])
    if (!columns.has(name))
      sqlite.exec(`ALTER TABLE catalog_project_imports ADD COLUMN ${name} TEXT`);
  sqlite.exec(
    readFileSync(
      new URL('../migrations/0043_workspace_portfolio_snapshot.sql', import.meta.url),
      'utf8',
    ),
  );
}
