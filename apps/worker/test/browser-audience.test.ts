import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { localBrowserReport, queryBrowserReport } from '../src/browser-reports.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const now = 1_800_000_000_000;
const day = 86400000;
const batch = (
  session: string,
  visitor?: string,
  visit_type?: 'new' | 'returning',
  days = 0,
): CollectedBrowserBatch => ({
  workspace: 'workspace',
  app_id: 'app',
  environment_id: 'env',
  batch_id: crypto.randomUUID(),
  received_at: now,
  session_hash: session,
  visitor_hash: visitor,
  visit_type,
  attribution: {
    source: 'launch',
    medium: 'email',
    campaign: 'hello',
    content: '',
    term: '',
    entry_path: '/start',
  },
  metadata: { channel: 'Email', device: 'Desktop', browser: 'Firefox', country: 'IN' },
  events: [
    {
      event_id: crypto.randomUUID(),
      timestamp: now - days * 86400000 - 1000,
      type: 'pageview',
      path: '/pricing',
      referrer: '',
    },
  ],
});
describe('visitor reporting across periods and legacy clients', () => {
  it.each(
    Array.from({ length: 14 }, (_, index) => ({
      mask: (index % 7) + 1,
      sampleInterval: index < 7 ? 1 : 3,
    })),
  )(
    'partitions mixed session cohorts locally and in generated SQL: $mask, sample $sampleInterval',
    async ({ mask, sampleInterval }) => {
      const database = new DatabaseSync(':memory:');
      database.exec(
        `CREATE TABLE app_health_browser_v1 (index1 TEXT, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')}, double1 REAL, double2 REAL, _sample_interval INTEGER)`,
      );
      const rows: CollectedBrowserBatch[] = [];
      for (const days of [0, 8]) {
        const prefix = days ? 'previous' : 'current';
        rows.push(
          batch(`${prefix}-new`, 'new-visitor', 'new', days),
          batch(`${prefix}-returning`, 'returning-visitor', 'returning', days),
          batch(`${prefix}-unknown`, undefined, undefined, days),
          batch('', undefined, undefined, days),
        );
        for (const [index, type] of ['new', 'returning', undefined].entries()) {
          if (mask & (1 << index))
            rows.push(
              batch(
                `${prefix}-mixed`,
                type ? 'mixed-visitor' : undefined,
                type as 'new' | 'returning' | undefined,
                days,
              ),
            );
        }
      }
      rows.push(
        { ...batch('other-app', 'other-visitor', 'new'), app_id: 'other-app' },
        { ...batch('other-workspace', 'other-visitor', 'new'), workspace: 'other-workspace' },
        {
          ...batch('other-environment', 'other-visitor', 'new'),
          environment_id: 'other-environment',
        },
      );
      const insert = database.prepare(
        'INSERT INTO app_health_browser_v1 (index1,blob1,blob2,blob3,blob4,blob5,blob7,blob8,blob9,blob10,blob11,blob12,blob13,blob14,blob15,blob16,blob17,double1,double2,_sample_interval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const row of rows) {
        row.events.push({
          ...row.events[0],
          event_id: crypto.randomUUID(),
          type: 'event',
          name: 'opened',
        });
        for (const event of row.events)
          insert.run(
            row.workspace,
            row.app_id,
            row.environment_id,
            event.type,
            event.path,
            event.name ?? '',
            row.session_hash ?? '',
            row.visitor_hash ?? '',
            row.visit_type ?? '',
            'launch',
            'email',
            'hello',
            'Email',
            'Desktop',
            'Firefox',
            'IN',
            '/start',
            1,
            event.timestamp,
            sampleInterval,
          );
      }
      const newSessions = 1 + Number(Boolean(mask & 1));
      const returningSessions = 1 + Number(!(mask & 1) && Boolean(mask & 2));
      const unidentified = 1 + Number(!(mask & 3));
      const expected = {
        new_sessions: newSessions,
        returning_sessions: returningSessions,
        unidentified_sessions: unidentified,
      };
      const cohort = (report: ReturnType<typeof localBrowserReport>) => ({
        new_sessions: report.audience?.new_sessions,
        returning_sessions: report.audience?.returning_sessions,
        unidentified_sessions: report.audience?.unidentified_sessions,
      });
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        for (const extra of [
          {},
          { path: '/pricing', source: 'launch', country: 'IN' },
          { event: 'opened' },
        ]) {
          const queries: string[] = [];
          const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
            const sql = String(init?.body);
            queries.push(sql);
            return Response.json({ data: database.prepare(sqliteAnalyticsSql(sql)).all() });
          });
          const filter = { range: '7d' as const, app_id: 'app', environment_id: 'env', ...extra };
          const local = localBrowserReport(
            rows.filter((row) => row.workspace === 'workspace'),
            filter,
            now,
          );
          const remote = await queryBrowserReport('workspace', filter, {
            accountId: 'a'.repeat(32),
            token: 'fixture',
            fetchImpl,
          });
          expect(cohort(local)).toEqual(expected);
          expect(cohort(remote)).toEqual(expected);
          expect(local.sessions).toBe(4);
          expect(remote.sessions).toBe(4);
          expect(newSessions + returningSessions + unidentified).toBe(remote.sessions);
          expect(remote.sampled).toBe(sampleInterval > 1);
          expect(fetchImpl).toHaveBeenCalledTimes(Object.keys(extra).length ? 8 : 10);
          const previous = database
            .prepare(sqliteAnalyticsSql(queries.find((sql) => sql.includes('GROUP BY period'))!))
            .all()
            .find((row) => row.period === 0)!;
          const localPrevious = localBrowserReport(
            rows.filter((row) => row.workspace === 'workspace'),
            filter,
            now - 7 * day,
            false,
          );
          expect(cohort(localPrevious)).toEqual(expected);
          expect({
            new_sessions: previous.new_sessions,
            returning_sessions: previous.returning_sessions,
            unidentified_sessions: previous.unidentified_sessions,
          }).toEqual(expected);
          expect(remote.previous?.sessions).toBe(4);
        }
      } finally {
        clock.mockRestore();
        database.close();
      }
    },
  );
  it('counts a repeat visitor once across days, while counting distinct visits and unknown sessions', () => {
    const rows = [
      batch('s1', 'v1', 'new', 2),
      batch('s2', 'v1', 'returning'),
      batch('s3'),
      batch('s4', 'v2', 'new', 8),
    ];
    const report = localBrowserReport(rows, { range: '7d', breakdown: 'acquisition' }, now);
    expect(report.audience).toMatchObject({
      visitors: 1,
      new_sessions: 1,
      returning_sessions: 1,
      unidentified_sessions: 1,
      channels: [{ name: 'Email', count: 3 }],
      campaigns: [{ name: 'hello', count: 3 }],
      devices: [],
      entry_pages: [],
    });
    expect(report.previous).toEqual({ pageviews: 1, events: 0, visitors: 1, sessions: 1 });
    expect(report.sources).toEqual([{ name: 'launch', count: 3 }]);
  });
  it('executes generated aggregate SQL against legacy empty IDs and previous periods', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(
      `CREATE TABLE app_health_browser_v1 (index1 TEXT, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')}, double1 REAL, double2 REAL, _sample_interval INTEGER)`,
    );
    const insert = database.prepare(
      'INSERT INTO app_health_browser_v1 (index1,blob1,blob2,blob3,blob4,blob7,blob8,blob9,blob10,blob13,blob17,double1,double2,_sample_interval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const row of [
      batch('s1', 'v1', 'new', 2),
      batch('s2', 'v1', 'returning'),
      batch('s3'),
      batch('', undefined),
      batch('s4', 'v2', 'new', 8),
    ])
      insert.run(
        'workspace',
        'app',
        'env',
        'pageview',
        '/pricing',
        row.session_hash ?? '',
        row.visitor_hash ?? '',
        row.visit_type ?? '',
        'launch',
        'Email',
        '/start',
        1,
        row.events[0].timestamp,
        1,
      );
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      Response.json({ data: database.prepare(sqliteAnalyticsSql(String(init?.body))).all() }),
    );
    try {
      const report = await queryBrowserReport(
        'workspace',
        { range: '7d', app_id: 'app' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(report.audience).toMatchObject({
        visitors: 1,
        new_sessions: 1,
        returning_sessions: 1,
        unidentified_sessions: 1,
        countries: [{ name: 'Unknown', count: 4 }],
      });
      expect(report.previous).toEqual({ pageviews: 1, events: 0, visitors: 1, sessions: 1 });
      expect(report.sessions).toBe(3);
      expect(fetchImpl).toHaveBeenCalledTimes(10);
      database
        .prepare(
          'INSERT INTO app_health_browser_v1 (index1,blob1,blob2,blob3,blob4,blob5,blob6,blob7,blob10,blob12,blob13,blob14,blob15,blob16,blob17,double1,double2,_sample_interval) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          'workspace',
          'app',
          'env',
          'pageview',
          "/a'b",
          '',
          'google.com',
          'quoted-session',
          'google.com',
          'hello',
          'Email',
          'Mobile',
          'Chrome',
          'IN',
          '/start',
          1,
          now - 100,
          1,
        );
      const segmented = await queryBrowserReport(
        'workspace',
        {
          range: '7d',
          app_id: 'app',
          path: "/a'b",
          entry_path: '/start',
          source: 'google.com',
          country: 'IN',
          device: 'Mobile',
          browser: 'Chrome',
          channel: 'Email',
          campaign: 'hello',
        },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(segmented.pages).toEqual([{ name: "/a'b", count: 1 }]);
      expect(segmented.engagement).toBeUndefined();
      const empty = await queryBrowserReport(
        'workspace',
        { range: '7d', app_id: 'absent' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(empty.audience?.visitors).toBe(0);
      expect(empty.previous).toEqual({ pageviews: 0, events: 0, visitors: 0, sessions: 0 });
      database
        .prepare('DELETE FROM app_health_browser_v1 WHERE double2 >= ?')
        .run(now - 7 * 86400000);
      database.prepare('UPDATE app_health_browser_v1 SET _sample_interval = 3').run();
      const previousOnly = await queryBrowserReport(
        'workspace',
        { range: '7d', app_id: 'app' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(previousOnly.audience?.visitors).toBe(0);
      expect(previousOnly.sessions).toBe(0);
      expect(previousOnly.previous).toEqual({ pageviews: 3, events: 0, visitors: 1, sessions: 1 });
      expect(previousOnly.sampled).toBe(true);
    } finally {
      database.close();
      vi.restoreAllMocks();
    }
  });
});
