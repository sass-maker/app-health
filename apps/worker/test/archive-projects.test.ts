import { URL } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';

it('archives only approved ID/name pairs, revokes all key families and shares, and preserves telemetry', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const sample = 'app-665880d9-287d-4a00-afcb-f564e19f36ff';
  const renamed = 'app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf';
  for (const [id, name] of [
    [sample, 'Cloudflare sample'],
    [renamed, 'Real product now'],
    ['real', 'Highsignal'],
  ]) {
    db.prepare('INSERT INTO apps(id, name, created_at) VALUES (?, ?, 1)').run(id, name);
    db.prepare('INSERT INTO environments VALUES (?, ?, ?, 1)').run(id, id, 'production');
    db.prepare('INSERT INTO keys VALUES (?, ?, ?, ?, 1, NULL)').run(id, id, id, id);
    db.prepare('INSERT INTO product_keys VALUES (?, ?, ?, 1, NULL)').run(id, id, id);
    db.prepare('INSERT INTO public_log_keys VALUES (?, ?, ?, ?, ?, 1, NULL)').run(
      id,
      id,
      id,
      id,
      '[]',
    );
    db.prepare('INSERT INTO native_keys VALUES (?, ?, ?, ?, ?, 1, NULL)').run(id, 'ws', id, id, id);
    db.prepare(
      'INSERT INTO analytics_shares(id, workspace_id, app_id, environment_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?, 1)',
    ).run(id, 'ws', id, id, id);
    db.prepare(
      "INSERT INTO log_events(log_id, app_id, environment_id, timestamp, event, level) VALUES (?, ?, ?, 1, 'test', 'info')",
    ).run(id, id, id);
  }
  const cleanup = readFileSync(
    new URL('../../../scripts/archive-test-projects.sql', import.meta.url),
    'utf8',
  );
  db.exec(cleanup);
  db.exec(cleanup);
  expect(db.prepare('SELECT id FROM apps WHERE archived_at IS NOT NULL').all()).toEqual([
    { id: sample },
  ]);
  for (const table of [
    'keys',
    'product_keys',
    'public_log_keys',
    'native_keys',
    'analytics_shares',
  ]) {
    expect(db.prepare(`SELECT app_id FROM ${table} WHERE revoked_at IS NOT NULL`).all()).toEqual([
      { app_id: sample },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 3 });
  }
  expect(db.prepare('SELECT COUNT(*) AS count FROM log_events').get()).toMatchObject({ count: 3 });
  db.close();
});
