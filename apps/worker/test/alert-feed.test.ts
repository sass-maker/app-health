import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readOwnerAlertFeed } from '../src/alert-feed.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';

describe('readOwnerAlertFeed', () => {
  it('returns only recent production event metadata from the authenticated workspace', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE environments (id TEXT, app_id TEXT, name TEXT);
        CREATE TABLE catalog_project_imports
          (workspace_id TEXT, catalog_id TEXT, catalog_name TEXT, app_id TEXT, lifecycle TEXT);
        CREATE TABLE log_events
          (log_id TEXT, app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, props TEXT);
        INSERT INTO environments VALUES
          ('prod-a', 'app-a', 'production'), ('stage-a', 'app-a', 'staging'),
          ('prod-b', 'app-b', 'production'), ('prod-maker', 'saas-maker', 'production');
        INSERT INTO catalog_project_imports VALUES
          ('ws-a', 'atlas', 'Atlas', 'app-a', 'active'),
          ('ws-a', 'saas-maker', 'SaaS Maker', 'saas-maker', 'active'),
          ('ws-a', 'retired', 'Retired', 'app-old', 'retired'),
          ('ws-b', 'other', 'Other', 'app-b', 'active');`);
      const insert = sqlite.prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?, ?)');
      insert.run(
        'feedback-1',
        'app-a',
        'prod-a',
        1_700_000_000_000,
        'feedback.submitted',
        '{"email":"private"}',
      );
      insert.run(
        'waitlist-1',
        'app-a',
        'prod-a',
        1_700_000_000_100,
        'waitlist.join',
        '{"email":"private"}',
      );
      insert.run('staging-1', 'app-a', 'stage-a', 1_700_000_000_200, 'feedback.submitted', '{}');
      insert.run('other-1', 'app-b', 'prod-b', 1_700_000_000_300, 'feedback.submitted', '{}');
      insert.run(
        'foreign-forged-target',
        'app-b',
        'prod-b',
        1_700_000_000_350,
        'feedback.submitted',
        '{"project":"atlas"}',
      );
      insert.run(
        'unknown-event-1',
        'app-a',
        'prod-a',
        1_700_000_000_400,
        'newsletter.subscribe',
        '{}',
      );
      insert.run(
        'central-known',
        'saas-maker',
        'prod-maker',
        1_700_000_000_500,
        'feedback.submitted',
        '{"project_id":"saas-maker-uuid","project":"atlas","email":"private"}',
      );
      insert.run(
        'central-unknown',
        'saas-maker',
        'prod-maker',
        1_700_000_000_600,
        'waitlist.join',
        '{"project":"not-in-catalog"}',
      );
      insert.run('expired-1', 'app-a', 'prod-a', 1_600_000_000_000, 'feedback.submitted', '{}');

      const db = {
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                first: async () => sqlite.prepare(sql).get(...(values as Array<string | number>)),
                all: async () => ({
                  results: sqlite.prepare(sql).all(...(values as Array<string | number>)),
                }),
              };
            },
          };
        },
      } as unknown as D1DatabaseLike;

      const now = 1_700_000_000_700;
      const result = await readOwnerAlertFeed(db, 'ws-a', now, 10);
      expect(result).toEqual({
        generated_at: now,
        total_count: 3,
        entries: [
          {
            id: 'central-known',
            app_id: 'saas-maker',
            catalog_id: 'atlas',
            project_name: 'Atlas',
            event: 'feedback.submitted',
            timestamp: 1_700_000_000_500,
          },
          {
            id: 'waitlist-1',
            app_id: 'app-a',
            catalog_id: 'atlas',
            project_name: 'Atlas',
            event: 'waitlist.join',
            timestamp: 1_700_000_000_100,
          },
          expect.objectContaining({ id: 'feedback-1' }),
        ],
      });
      expect(JSON.stringify(result)).not.toContain('private');
    } finally {
      sqlite.close();
    }
  });

  it('clamps the requested result size to the fixed maximum', async () => {
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        statements.push(sql);
        return {
          bind(...values: unknown[]) {
            bindings.push(values);
            return {
              first: async () => ({ total_count: 0 }),
              all: async () => ({ results: [] }),
            };
          },
        };
      },
    } as unknown as D1DatabaseLike;
    await readOwnerAlertFeed(db, 'ws-a', 1_700_000_000_000, 500);
    expect(statements[1]).toContain('LIMIT ?');
    expect(bindings[1]).toEqual([
      'ws-a',
      1_697_408_000_000,
      1_700_000_000_000,
      'ws-a',
      'ws-a',
      'ws-a',
      50,
    ]);
  });
});
