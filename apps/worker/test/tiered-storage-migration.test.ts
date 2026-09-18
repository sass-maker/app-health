import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function migratedDb(upTo = '0016') {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith('.sql') && file.slice(0, 4) <= upTo)
    .sort())
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  return db;
}

function seedScope(db: DatabaseSync) {
  db.prepare("INSERT INTO apps(id, name, created_at) VALUES ('app', 'App', 1)").run();
  db.prepare(
    "INSERT INTO environments(id, app_id, name, created_at) VALUES ('production', 'app', 'Production', 1)",
  ).run();
}

describe('tiered analytics storage migration (0017)', () => {
  it('applies after all prior migrations and remains replayable', () => {
    const db = migratedDb('0016');
    const migration = readFileSync(
      new URL('../migrations/0017_tiered_analytics_storage.sql', import.meta.url),
      'utf8',
    );
    db.exec(migration);
    db.exec(migration);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'analytics_%' ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: 'analytics_archive_segments' },
      { name: 'analytics_compaction_receipts' },
      { name: 'analytics_rollup_repairs' },
      { name: 'analytics_rollups' },
      { name: 'analytics_shares' },
    ]);
    db.close();
  });

  it('enforces verified lineage and exactly-once source-bucket receipts', () => {
    const db = migratedDb('0016');
    db.exec(
      readFileSync(
        new URL('../migrations/0017_tiered_analytics_storage.sql', import.meta.url),
        'utf8',
      ),
    );
    seedScope(db);
    const source = 'browser-v2/2026/09/18/source.jsonl.gz';
    db.prepare(
      `INSERT INTO analytics_archive_segments(
        object_key, workspace_id, format, schema_version, content_sha256,
        row_count, event_count, min_event_at, max_event_at,
        uncompressed_bytes, compressed_bytes, created_at, state
      ) VALUES (?, 'workspace', 'jsonl-gzip', 1, ?, 12, 30, 10, 20, 100, 60, 30, 'active')`,
    ).run(source, 'a'.repeat(64));
    db.prepare(
      `INSERT INTO analytics_rollups(
        workspace_id, app_id, environment_id, product, resolution, bucket_start,
        metric, dimension_key, dimensions, count, rollup_version, updated_at
      ) VALUES ('workspace', 'app', 'production', 'web', '1h', 0,
        'pageviews', '[]', '[]', 30, 1, 40)`,
    ).run();
    const receipt = db.prepare(
      `INSERT INTO analytics_compaction_receipts(
        source_key, resolution, bucket_start, rollup_version, source_sha256, applied_at
      ) VALUES (?, '1h', 0, 1, ?, 40)`,
    );
    receipt.run(source, 'a'.repeat(64));
    expect(() => receipt.run(source, 'a'.repeat(64))).toThrow();
    expect(() => receipt.run(source, 'b'.repeat(64))).toThrow('source hash mismatch');
    expect(() =>
      db
        .prepare(
          `UPDATE analytics_archive_segments
           SET state = 'superseded', replacement_key = NULL, verified_at = NULL
           WHERE object_key = ?`,
        )
        .run(source),
    ).toThrow();
    db.close();
  });
});
