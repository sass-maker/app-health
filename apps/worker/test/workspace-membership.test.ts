import { URL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

function migratedDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  return db;
}

describe('workspace membership and project sources (0016)', () => {
  it('applies cleanly after every earlier migration and seeds owner membership', () => {
    const db = migratedDb();
    db.prepare(
      "INSERT INTO \"user\"(id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('u1', 'Owner', 'o@example.com', 1, NULL, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO workspaces(id, owner_id, name, created_at) VALUES ('w1', 'u1', 'My workspace', 1)",
    ).run();
    db.exec(
      readFileSync(new URL('../migrations/0016_workspace_membership.sql', import.meta.url), 'utf8'),
    );

    const owners = db
      .prepare("SELECT role FROM workspace_members WHERE workspace_id = 'w1' AND user_id = 'u1'")
      .all() as Array<{ role: string }>;
    expect(owners).toEqual([{ role: 'owner' }]);

    // Re-running the migration is a no-op (replayable).
    db.exec(
      readFileSync(new URL('../migrations/0016_workspace_membership.sql', import.meta.url), 'utf8'),
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workspace_members').get() as { n: number }).n,
    ).toBe(1);
  });

  it('bounds membership roles and source kinds to the documented sets', () => {
    const db = migratedDb();
    db.prepare(
      "INSERT INTO \"user\"(id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('u1', 'Owner', 'o@example.com', 1, NULL, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO \"user\"(id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('u2', 'Member', 'm@example.com', 1, NULL, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO \"user\"(id, name, email, emailVerified, image, createdAt, updatedAt) VALUES ('u3', 'Other', 'x@example.com', 1, NULL, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO workspaces(id, owner_id, name, created_at) VALUES ('w1', 'u1', 'My workspace', 1)",
    ).run();
    db.exec(
      readFileSync(new URL('../migrations/0016_workspace_membership.sql', import.meta.url), 'utf8'),
    );

    db.prepare(
      "INSERT INTO workspace_members(workspace_id, user_id, role, created_at) VALUES ('w1', 'u2', 'viewer', 1)",
    ).run();
    // Duplicate membership is rejected...
    expect(() =>
      db
        .prepare(
          "INSERT INTO workspace_members(workspace_id, user_id, role, created_at) VALUES ('w1', 'u2', 'editor', 1)",
        )
        .run(),
    ).toThrow();
    // ...and so is a role outside the documented set.
    expect(() =>
      db
        .prepare(
          "INSERT INTO workspace_members(workspace_id, user_id, role, created_at) VALUES ('w1', 'u3', 'admin', 1)",
        )
        .run(),
    ).toThrow();

    db.prepare("INSERT INTO apps(id, name, created_at) VALUES ('app1', 'Product', 1)").run();
    db.prepare(
      "INSERT INTO environments(id, app_id, name, created_at) VALUES ('env1', 'app1', 'production', 1)",
    ).run();
    db.prepare(
      "INSERT INTO project_sources(id, app_id, environment_id, kind, label, created_at) VALUES ('s1', 'app1', 'env1', 'web', 'Marketing site', 1)",
    ).run();
    // Same (app, environment, kind) twice is rejected.
    expect(() =>
      db
        .prepare(
          "INSERT INTO project_sources(id, app_id, environment_id, kind, label, created_at) VALUES ('s2', 'app1', 'env1', 'web', 'Duplicate', 1)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO project_sources(id, app_id, environment_id, kind, label, created_at) VALUES ('s3', 'app1', 'env1', 'payment', 'Bad kind', 1)",
        )
        .run(),
    ).toThrow();
  });
});
