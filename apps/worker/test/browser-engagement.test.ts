import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { localBrowserReport, queryBrowserReport } from '../src/browser-reports.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const now = 1_800_000_000_000;
const makeBatch = (
  session_hash: string,
  events: CollectedBrowserBatch['events'],
): CollectedBrowserBatch => ({
  workspace: 'workspace',
  app_id: 'app',
  environment_id: 'env',
  batch_id: crypto.randomUUID(),
  received_at: now,
  session_hash,
  events,
});
const pageview = (timestamp: number, path: string) => ({
  event_id: crypto.randomUUID(),
  timestamp,
  type: 'pageview' as const,
  path,
  referrer: '',
});
const namedEvent = (timestamp: number) => ({
  event_id: crypto.randomUUID(),
  timestamp,
  type: 'event' as const,
  path: '/',
  name: 'checkout.started',
  referrer: '',
});

describe('browser engagement metrics', () => {
  it('computes session metrics from observed events and excludes event-only sessions', () => {
    const report = localBrowserReport(
      [
        makeBatch('multi', [
          pageview(now - 10_000, '/'),
          namedEvent(now - 5_000),
          pageview(now - 1_000, '/done'),
        ]),
        makeBatch('bounce', [pageview(now - 8_000, '/pricing')]),
        makeBatch('event-only', [namedEvent(now - 2_000)]),
      ],
      { range: '24h' },
      now,
    );
    expect(report.engagement).toEqual({
      pages_per_session: 1.5,
      bounce_rate: 0.5,
      average_session_duration_ms: 4_500,
      exit_pages: [
        { name: '/done', count: 1 },
        { name: '/pricing', count: 1 },
      ],
    });
  });

  it('keeps sessions truncated at the report window and returns null denominators', () => {
    const report = localBrowserReport(
      [
        makeBatch('outside', [pageview(now - 90_000_000, '/old')]),
        makeBatch('inside', [pageview(now - 1_000, '/current')]),
      ],
      { range: '1h' },
      now,
    );
    expect(report.engagement?.bounce_rate).toBe(1);
    expect(report.engagement?.average_session_duration_ms).toBe(0);
    const empty = localBrowserReport([], { range: '1h' }, now);
    expect(empty.engagement).toEqual({
      pages_per_session: null,
      bounce_rate: null,
      average_session_duration_ms: null,
      exit_pages: [],
    });
  });

  it('chooses the latest pageview exit even when a later event is observed', () => {
    const report = localBrowserReport(
      [
        makeBatch('out-of-order', [
          pageview(now - 1_000, '/latest'),
          namedEvent(now - 100),
          pageview(now - 2_000, '/older'),
        ]),
      ],
      { range: '1h' },
      now,
    );
    expect(report.engagement?.exit_pages).toEqual([{ name: '/latest', count: 1 }]);
  });

  it('executes bounded AE session and exit SQL against representative rows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const database = new DatabaseSync(':memory:');
    database.exec(
      `CREATE TABLE app_health_browser_v1 (index1 TEXT, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')}, double1 REAL, double2 REAL, _sample_interval INTEGER)`,
    );
    database.aggregate('argMax', {
      start: '',
      step: (state: string, value: unknown, key: unknown) => {
        const previous = state ? Number(state.split('\u0000', 1)[0]) : -Infinity;
        return Number(key) >= previous ? `${Number(key)}\u0000${String(value)}` : state;
      },
      result: (state: string) => state.slice(state.indexOf('\u0000') + 1),
    });
    const insert = database.prepare(
      'INSERT INTO app_health_browser_v1 (index1,blob1,blob2,blob3,blob4,blob7,double1,double2,_sample_interval) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    const add = (
      app: string,
      env: string,
      session: string,
      type: 'pageview' | 'event',
      path: string,
      timestamp: number,
    ) => insert.run('workspace', app, env, type, path, session, 1, timestamp, 1);
    add('app-a', 'env-a', 'shared', 'pageview', '/a', now - 10_000);
    add('app-a', 'env-a', 'shared', 'pageview', '/b', now - 1_000);
    add('app-a', 'env-a', 'shared', 'event', '/', now - 500);
    add('app-b', 'env-b', 'shared', 'pageview', '/other', now - 2_000);
    let queryError: unknown;
    let failEngagement = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      try {
        if (failEngagement && String(init?.body).includes('pageview_sessions'))
          throw new Error('optional engagement unavailable');
        return Response.json({
          data: database.prepare(sqliteAnalyticsSql(String(init?.body))).all(),
        });
      } catch (error) {
        queryError = error;
        if (failEngagement) throw error;
        return Response.json({ data: [] });
      }
    });
    try {
      const report = await queryBrowserReport(
        'workspace',
        { range: '24h' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(queryError).toBeUndefined();
      expect(report.engagement).toEqual({
        pages_per_session: 1.5,
        bounce_rate: 0.5,
        average_session_duration_ms: 4_750,
        exit_pages: [
          { name: '/b', count: 1 },
          { name: '/other', count: 1 },
        ],
      });
      database.exec('UPDATE app_health_browser_v1 SET _sample_interval = 2');
      const sampled = await queryBrowserReport(
        'workspace',
        { range: '24h' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(sampled.sampled).toBe(true);
      expect(sampled.engagement).toEqual({
        pages_per_session: null,
        bounce_rate: null,
        average_session_duration_ms: null,
        exit_pages: [],
      });
      failEngagement = true;
      const coreOnly = await queryBrowserReport(
        'workspace',
        { range: '24h' },
        { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
      );
      expect(coreOnly.engagement).toBeUndefined();
    } finally {
      database.close();
      vi.useRealTimers();
    }
  });

  it('starts optional engagement queries while core analytics are still pending', async () => {
    let releaseCore!: () => void;
    const coreGate = new Promise<void>((resolve) => {
      releaseCore = resolve;
    });
    let blockedCore = false;
    let optionalStarted = false;
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const sql = String(init?.body);
      if (!blockedCore && !sql.includes('pageview_sessions')) {
        blockedCore = true;
        await coreGate;
      }
      if (sql.includes('pageview_sessions')) optionalStarted = true;
      return Response.json({ data: [] });
    });
    const report = queryBrowserReport(
      'workspace',
      { range: '24h' },
      { accountId: 'a'.repeat(32), token: 'fixture', fetchImpl },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(optionalStarted).toBe(true);
    releaseCore();
    await report;
  });
});
