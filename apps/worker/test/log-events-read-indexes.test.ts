import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOwnerAlertFeed } from '../src/alert-feed.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';
import { readDailyEngagementLogs } from '../src/daily-engagement-report.js';

// Production (2026-10-09) holds ~370k log_events in the 30-day window, 99.5% of
// them one app's info `traffic.summary`. Owner reads that filter by event or
// level must use the event/level indexes instead of walking every row in the
// time range (idx_log_events_expiry) or every row of an app (scope_time).
const NOW = 1_791_557_000_000;
const DAY = 86_400_000;
const NOISE_ROWS = 4_000;

type Captured = { sql: string; values: unknown[] };

function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(file, migrations), 'utf8'));
  return sqlite;
}

function seed(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO apps (id, name, created_at) VALUES ('app-noisy', 'Noisy', 0), ('app-a', 'A', 0);
    INSERT INTO workspace_apps (app_id, workspace_id) VALUES ('app-noisy', 'ws'), ('app-a', 'ws');
    INSERT INTO environments (id, app_id, name, created_at) VALUES
      ('env-noisy', 'app-noisy', 'production', 0), ('env-a', 'app-a', 'production', 0);
    INSERT INTO catalog_project_imports
      (workspace_id, catalog_id, catalog_name, app_id, lifecycle, payload_sha256, created_at)
    VALUES
      ('ws', 'noisy', 'Noisy', 'app-noisy', 'active', '${'0'.repeat(64)}', 0),
      ('ws', 'atlas', 'Atlas', 'app-a', 'active', '${'0'.repeat(64)}', 0);`);
  const insert = sqlite.prepare(
    `INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, level, props, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'server')`,
  );
  sqlite.exec('BEGIN');
  for (let index = 0; index < NOISE_ROWS; index += 1)
    insert.run(
      `noise-${index}`,
      'app-noisy',
      'env-noisy',
      NOW - index * 600_000,
      'traffic.summary',
      'info',
      '{}',
    );
  insert.run('feedback', 'app-a', 'env-a', NOW - 1_000, 'feedback.submitted', 'info', '{}');
  insert.run('error', 'app-a', 'env-a', NOW - 2_000, 'client.error', 'error', '{}');
  insert.run('degraded', 'app-a', 'env-a', NOW - 3_000, 'checkout.degraded', 'warn', '{}');
  insert.run(
    'probe',
    'app-a',
    'env-a',
    NOW - 4_000,
    'probe.heartbeat',
    'info',
    '{"location":"ams"}',
  );
  sqlite.exec('COMMIT');
}

function capturingD1(sqlite: DatabaseSync, captured: Captured[]) {
  const statement = (sql: string, values: unknown[]) => ({
    all: async () => {
      captured.push({ sql, values });
      return {
        results: sqlite.prepare(sql).all(...(values as Array<string | number>)),
        success: true,
        meta: {},
      };
    },
  });
  return {
    batch: async (statements: Array<{ all(): Promise<unknown> }>) =>
      Promise.all(statements.map((item) => item.all())),
    prepare: (sql: string) => ({ bind: (...values: unknown[]) => statement(sql, values) }),
  } as unknown as D1DatabaseLike;
}

function logEventPlan(sqlite: DatabaseSync, { sql, values }: Captured) {
  return (
    sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(values as Array<string | number>)) as Array<{ detail: string }>
  )
    .map((row) => row.detail)
    .filter((detail) => /^(SCAN|SEARCH) (l|log_events)\b/.test(detail));
}

describe('owner log_events reads', () => {
  let sqlite: DatabaseSync;
  beforeEach(() => {
    sqlite = migratedDatabase();
    seed(sqlite);
  });
  afterEach(() => sqlite.close());

  it('reach alert-feed rows through the event and level indexes', async () => {
    const captured: Captured[] = [];
    const feed = await readOwnerAlertFeed(capturingD1(sqlite, captured), 'ws', NOW);
    expect(feed.total_count).toBe(3);
    expect(feed.entries.map((entry) => entry.id)).toEqual(['feedback', 'error', 'degraded']);
    expect(feed.probes.map((probe) => probe.location)).toEqual(['ams']);
    expect(captured).toHaveLength(3);
    for (const query of captured) {
      const plan = logEventPlan(sqlite, query);
      expect(plan.length).toBeGreaterThan(0);
      for (const detail of plan) {
        expect(detail).toMatch(/USING INDEX idx_log_events_(event|level)_time \((event|level)=/);
      }
    }
  });

  it('reach daily engagement joins through the event index', async () => {
    const captured: Captured[] = [];
    const rows = await readDailyEngagementLogs(
      capturingD1(sqlite, captured),
      ['app-noisy', 'app-a'],
      NOW - DAY,
      NOW,
    );
    expect(rows).toEqual([expect.objectContaining({ app_id: 'app-a', count: 1 })]);
    expect(captured).toHaveLength(1);
    for (const detail of logEventPlan(sqlite, captured[0]!))
      expect(detail).toMatch(/USING INDEX idx_log_events_event_time \(event=/);
  });
});
