import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { localBrowserReport, queryBrowserReport } from '../src/browser-reports.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const now = 1_800_000_000_000;
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
      Response.json({ data: database.prepare(String(init?.body)).all() }),
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
      });
      expect(report.previous).toEqual({ pageviews: 1, events: 0, visitors: 1, sessions: 1 });
      expect(report.sessions).toBe(3);
      const empty = await queryBrowserReport(
        'workspace',
        { range: '7d', app_id: 'absent' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(empty.audience?.visitors).toBe(0);
      expect(empty.previous).toEqual({ pageviews: 0, events: 0, visitors: 0, sessions: 0 });
    } finally {
      database.close();
      vi.restoreAllMocks();
    }
  });
});
