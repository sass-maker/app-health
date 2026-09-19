import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

it('applies catalog mapping migration after every prior schema and replays without changing data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .sort())
      db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    const migration = readFileSync(new URL('0018_catalog_imports.sql', migrations), 'utf8');
    db.exec(migration);
    const objects = db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE name IN ('catalog_project_imports', 'catalog_import_scope', 'catalog_import_identity') ORDER BY name",
      )
      .all();
    expect(objects).toEqual([
      { type: 'trigger', name: 'catalog_import_identity' },
      { type: 'trigger', name: 'catalog_import_scope' },
      { type: 'table', name: 'catalog_project_imports' },
    ]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO catalog_project_imports(workspace_id, catalog_id, catalog_name, app_id, lifecycle, payload_sha256, created_at) VALUES ('foreign', 'project', 'Project', 'unowned', 'active', ?, 1)",
        )
        .run('a'.repeat(64)),
    ).toThrow('project scope mismatch');
    expect(db.prepare('SELECT COUNT(*) AS count FROM catalog_project_imports').get()).toMatchObject(
      { count: 0 },
    );
  } finally {
    db.close();
  }
});
