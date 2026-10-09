import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
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
          (log_id TEXT, app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, props TEXT,
            level TEXT NOT NULL DEFAULT 'info', source TEXT NOT NULL DEFAULT 'server');
        INSERT INTO environments VALUES
          ('prod-a', 'app-a', 'production'), ('stage-a', 'app-a', 'staging'),
          ('prod-b', 'app-b', 'production'), ('prod-maker', 'saas-maker', 'production');
        INSERT INTO catalog_project_imports VALUES
          ('ws-a', 'atlas', 'Atlas', 'app-a', 'active'),
          ('ws-a', 'saas-maker', 'SaaS Maker', 'saas-maker', 'active'),
          ('ws-a', 'retired', 'Retired', 'app-old', 'retired'),
          ('ws-b', 'other', 'Other', 'app-b', 'active');`);
      const insert = sqlite.prepare(
        'INSERT INTO log_events (log_id, app_id, environment_id, timestamp, event, props) VALUES (?, ?, ?, ?, ?, ?)',
      );
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
        'newsletter-1',
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
      const insertAlert = sqlite.prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const alerts: Array<[string, string, string, number, string, string, string, string]> = [
        [
          'browser-error',
          'app-a',
          'prod-a',
          1_700_000_000_610,
          'recommendation.failed',
          '{"prompt":"private"}',
          'error',
          'browser',
        ],
        [
          'server-degraded',
          'app-a',
          'prod-a',
          1_700_000_000_620,
          'recommendation.degraded',
          '{"body":"private"}',
          'warn',
          'server',
        ],
        [
          'server-error',
          'app-a',
          'prod-a',
          1_700_000_000_630,
          'endpoint.failed',
          '{"headers":"private"}',
          'error',
          'server',
        ],
        [
          'native-error',
          'app-a',
          'prod-a',
          1_700_000_000_640,
          'runtime.error',
          '{"email":"private"}',
          'error',
          'native',
        ],
        [
          'unrelated-warning',
          'app-a',
          'prod-a',
          1_700_000_000_660,
          'cache.miss',
          '{}',
          'warn',
          'server',
        ],
        [
          'info-degraded',
          'app-a',
          'prod-a',
          1_700_000_000_670,
          'recommendation.degraded',
          '{}',
          'info',
          'server',
        ],
        [
          'staging-error',
          'app-a',
          'stage-a',
          1_700_000_000_680,
          'endpoint.failed',
          '{}',
          'error',
          'server',
        ],
        [
          'foreign-error',
          'app-b',
          'prod-b',
          1_700_000_000_690,
          'endpoint.failed',
          '{"project":"atlas"}',
          'error',
          'server',
        ],
        [
          'future-error',
          'app-a',
          'prod-a',
          1_700_000_000_710,
          'endpoint.failed',
          '{}',
          'error',
          'server',
        ],
        [
          'expired-error',
          'app-a',
          'prod-a',
          1_600_000_000_000,
          'endpoint.failed',
          '{}',
          'error',
          'server',
        ],
      ];
      for (const alert of alerts) insertAlert.run(...alert);

      const db = {
        batch: vi.fn(async (statements: Array<{ all(): Promise<{ results: unknown[] }> }>) =>
          Promise.all(
            statements.map(async (statement) => ({
              ...(await statement.all()),
              success: true,
              meta: {},
            })),
          ),
        ),
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
      expect(db.batch).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        generated_at: now,
        total_count: 8,
        entries: [
          expect.objectContaining({
            id: 'native-error',
            event: 'runtime.error',
            level: 'error',
            source: 'native',
          }),
          expect.objectContaining({
            id: 'server-error',
            event: 'endpoint.failed',
            level: 'error',
            source: 'server',
          }),
          expect.objectContaining({
            id: 'server-degraded',
            event: 'recommendation.degraded',
            level: 'warn',
            source: 'server',
          }),
          expect.objectContaining({
            id: 'browser-error',
            event: 'recommendation.failed',
            level: 'error',
            source: 'browser',
          }),
          {
            id: 'central-known',
            app_id: 'saas-maker',
            catalog_id: 'atlas',
            project_name: 'Atlas',
            event: 'feedback.submitted',
            level: 'info',
            source: 'server',
            timestamp: 1_700_000_000_500,
          },
          {
            id: 'newsletter-1',
            app_id: 'app-a',
            catalog_id: 'atlas',
            project_name: 'Atlas',
            event: 'newsletter.subscribe',
            level: 'info',
            source: 'server',
            timestamp: 1_700_000_000_400,
          },
          {
            id: 'waitlist-1',
            app_id: 'app-a',
            catalog_id: 'atlas',
            project_name: 'Atlas',
            event: 'waitlist.join',
            level: 'info',
            source: 'server',
            timestamp: 1_700_000_000_100,
          },
          expect.objectContaining({ id: 'feedback-1' }),
        ],
        probes: [],
      });
      expect(JSON.stringify(result)).not.toContain('private');
      expect(result.total_count).toBeLessThan(20);
      const limited = await readOwnerAlertFeed(db, 'ws-a', now, 2);
      expect(limited.total_count).toBe(8);
      expect(limited.entries).toEqual(result.entries.slice(0, 2));
    } finally {
      sqlite.close();
    }
  });

  it('surfaces synthetic journey incidents and probe location freshness', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(`CREATE TABLE environments (id TEXT, app_id TEXT, name TEXT);
        CREATE TABLE catalog_project_imports
          (workspace_id TEXT, catalog_id TEXT, catalog_name TEXT, app_id TEXT, lifecycle TEXT);
        CREATE TABLE log_events
          (log_id TEXT, app_id TEXT, environment_id TEXT, timestamp INTEGER, event TEXT, props TEXT,
            level TEXT NOT NULL DEFAULT 'info', source TEXT NOT NULL DEFAULT 'server');
        INSERT INTO environments VALUES
          ('prod-health', 'app-health', 'production'), ('prod-anime', 'app-anime', 'production'),
          ('prod-other', 'app-other', 'production');
        INSERT INTO catalog_project_imports VALUES
          ('ws-a', 'app-health', 'App Health', 'app-health', 'active'),
          ('ws-a', 'anime-list', 'Anime List', 'app-anime', 'active'),
          ('ws-b', 'other', 'Other', 'app-other', 'active');`);
      const insert = sqlite.prepare('INSERT INTO log_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const minute = 60_000;
      const now = 1_700_000_000_000;
      const rows: Array<[string, string, string, number, string, string, string, string]> = [
        [
          'failed',
          'app-health',
          'prod-health',
          now - 30 * minute,
          'journey.failed',
          '{"project":"anime-list","journey":"anime-search","location":"india-home","failure":"timeout"}',
          'error',
          'server',
        ],
        [
          'slow',
          'app-health',
          'prod-health',
          now - 20 * minute,
          'journey.degraded',
          '{"project":"anime-list","journey":"manga-search","location":"india-home"}',
          'warn',
          'server',
        ],
        [
          'recovered',
          'app-health',
          'prod-health',
          now - 10 * minute,
          'journey.recovered',
          '{"project":"anime-list","journey":"anime-search","location":"india-home"}',
          'info',
          'server',
        ],
        [
          'info-other',
          'app-health',
          'prod-health',
          now - 9 * minute,
          'journey.checked',
          '{"project":"anime-list"}',
          'info',
          'server',
        ],
        [
          'hb-old',
          'app-health',
          'prod-health',
          now - 60 * minute,
          'probe.heartbeat',
          '{"location":"india-home","interval_seconds":300}',
          'debug',
          'server',
        ],
        [
          'hb-new',
          'app-health',
          'prod-health',
          now - 4 * minute,
          'probe.heartbeat',
          '{"location":"india-home","interval_seconds":300}',
          'debug',
          'server',
        ],
        [
          'hb-remote',
          'app-health',
          'prod-health',
          now - 40 * minute,
          'probe.heartbeat',
          '{"location":"remote-us","interval_seconds":"bad"}',
          'debug',
          'server',
        ],
        [
          'hb-foreign',
          'app-other',
          'prod-other',
          now - minute,
          'probe.heartbeat',
          '{"location":"elsewhere","interval_seconds":300}',
          'debug',
          'server',
        ],
        [
          'hb-unnamed',
          'app-health',
          'prod-health',
          now - minute,
          'probe.heartbeat',
          '{}',
          'debug',
          'server',
        ],
      ];
      for (const row of rows) insert.run(...row);
      const db = {
        batch: async (statements: Array<{ all(): Promise<{ results: unknown[] }> }>) =>
          Promise.all(
            statements.map(async (statement) => ({
              ...(await statement.all()),
              success: true,
              meta: {},
            })),
          ),
        prepare(sql: string) {
          return {
            bind(...values: unknown[]) {
              return {
                all: async () => ({
                  results: sqlite.prepare(sql).all(...(values as Array<string | number>)),
                }),
              };
            },
          };
        },
      } as unknown as D1DatabaseLike;

      const feed = await readOwnerAlertFeed(db, 'ws-a', now, 10);
      expect(
        feed.entries.map((entry) => [entry.id, entry.catalog_id, entry.journey, entry.location]),
      ).toEqual([
        ['recovered', 'anime-list', 'anime-search', 'india-home'],
        ['slow', 'anime-list', 'manga-search', 'india-home'],
        ['failed', 'anime-list', 'anime-search', 'india-home'],
      ]);
      expect(JSON.stringify(feed.entries)).not.toContain('timeout');
      expect(feed.probes).toEqual([
        {
          location: 'india-home',
          last_seen_at: now - 4 * minute,
          interval_seconds: 300,
          state: 'fresh',
        },
        {
          location: 'remote-us',
          last_seen_at: now - 40 * minute,
          interval_seconds: 300,
          state: 'stale',
        },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('clamps the requested result size to the fixed maximum', async () => {
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const db = {
      batch: async () => [
        { success: true, results: [{ total_count: 0 }], meta: {} },
        { success: true, results: [], meta: {} },
        { success: true, results: [], meta: {} },
      ],
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

  it.each([
    [],
    [{ success: true, results: [{ total_count: 4 }], meta: {} }],
    [
      { success: false, results: [], meta: {} },
      { success: true, results: [], meta: {} },
    ],
    [
      { success: true, results: [{ total_count: 4 }], meta: {} },
      { success: false, results: [], meta: {} },
    ],
    [
      { success: true, results: [{ total_count: 4 }], meta: {} },
      { success: true, meta: {} },
    ],
    [
      { success: true, results: [], meta: {} },
      { success: true, results: [], meta: {} },
    ],
    [
      { success: true, results: [{ total_count: 0 }], meta: {} },
      { success: true, results: [], meta: {} },
      { success: true, meta: {} },
    ],
  ])(
    'rejects incomplete or failed database reads instead of returning an empty feed (%#)',
    async (...results) => {
      const statement = { bind: () => statement };
      const db = {
        prepare: () => statement,
        batch: async () => results,
      } as unknown as D1DatabaseLike;
      await expect(readOwnerAlertFeed(db, 'ws-a')).rejects.toThrow('D1 alert feed read failed');
    },
  );
});
