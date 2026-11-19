import { DatabaseSync } from 'node:sqlite';
import { queryBrowserReport } from '../src/browser-report-query.js';
import { sqliteAnalyticsSql } from './analytics-sqlite.js';
import type { BrowserReportFilter } from '@app-health/contracts';

export const engagementNow = Date.parse('2026-11-13T00:00:00+05:30');
export const engagementScope = {
  range: '24h' as const,
  app_id: 'app',
  environment_id: 'env',
  breakdown: 'technology' as const,
};
export function optionalFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(
    `CREATE TABLE app_health_browser_v1(index1 TEXT,${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')},double1 REAL,double2 REAL,_sample_interval REAL)`,
  );
  database.aggregate('argMax', {
    start: '',
    step: (state: string, value: unknown, key: unknown) =>
      Number(key) >= (state ? Number(state.split('~')[0]) : -Infinity)
        ? `${Number(key)}~${String(value)}`
        : state,
    result: (state: string) => state.slice(state.indexOf('~') + 1),
  });
  function add(extra: Record<string, string | number> = {}) {
    const row = {
      index1: 'workspace',
      blob1: 'app',
      blob2: 'env',
      blob3: 'pageview',
      blob4: '/page',
      blob5: '',
      blob7: 'session',
      blob8: 'visitor',
      blob9: 'new',
      blob10: 'google.com',
      blob13: 'Email',
      blob14: 'Desktop',
      blob15: 'Firefox',
      blob16: 'IN',
      blob17: '/entry',
      double1: 1,
      double2: engagementNow - 1000,
      _sample_interval: 1,
      ...extra,
    };
    database
      .prepare(
        `INSERT INTO app_health_browser_v1(${Object.keys(row).join(',')})VALUES(${Object.keys(row)
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(row));
  }
  function seed(count = 30, sessions = 10, paths = 5) {
    for (let i = 0; i < count; i++)
      add({
        blob7: `s${i % sessions}`,
        blob4: `/p${String(i % paths).padStart(2, '0')}`,
        double2: engagementNow - 1000 - i * 7,
      });
  }
  function rows(sql: string) {
    return database.prepare(sqliteAnalyticsSql(sql)).all();
  }
  return { database, add, seed, rows };
}
export const isCombinedEngagement = (sql: string) => sql.includes('AS ambiguous_sessions');
export type OptionalOverride = (
  sql: string,
  rows: Record<string, unknown>[],
  init: RequestInit,
) => Response | Promise<Response> | undefined;
export async function runOptionalFixture(
  fixture: ReturnType<typeof optionalFixture>,
  enabled = true,
  filter: BrowserReportFilter = engagementScope,
  override?: OptionalOverride,
) {
  const queries: string[] = [];
  const timings: NonNullable<Parameters<typeof queryBrowserReport>[2]['timings']> = {};
  const report = await queryBrowserReport('workspace', filter, {
    accountId: 'a'.repeat(32),
    token: 'synthetic',
    appIds: ['app'],
    optionalEngagement: enabled ? true : undefined,
    timings,
    fetchImpl: async (_input, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      return await (override?.(sql, fixture.rows(sql), init!) ??
        Response.json({ data: fixture.rows(sql) }));
    },
  });
  return { report, queries, timings };
}
