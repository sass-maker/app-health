import { DatabaseSync } from 'node:sqlite';
import { vi } from 'vitest';
import { sqliteAnalyticsSql } from './analytics-sqlite.js';

export const reportNow = 1_800_000_000_000;
export const reportScope = { range: '24h' as const, app_id: 'app', environment_id: 'env' };
export const isJoint = (sql: string) => sql.includes('GROUP BY event_kind');
export const isPages = (sql: string) => sql.startsWith('SELECT blob4 AS name');
export const isPeriods = (sql: string) => sql.includes('GROUP BY period');
export type FixtureRow = Record<string, string | number>;
export function rankingFixture() {
  const database = new DatabaseSync(':memory:');
  database.exec(
    `CREATE TABLE app_health_browser_v1 (index1 TEXT, ${Array.from({ length: 20 }, (_, i) => `blob${i + 1} TEXT DEFAULT ''`).join(',')}, double1 REAL, double2 REAL, _sample_interval REAL)`,
  );
  database.aggregate('argMax', {
    start: '',
    step: (state: string, value: unknown, key: unknown) =>
      Number(key) >= (state ? Number(state.split('\u0000', 1)[0]) : -Infinity)
        ? `${Number(key)}\u0000${String(value)}`
        : state,
    result: (state: string) => state.slice(state.indexOf('\u0000') + 1),
  });
  function add(overrides: FixtureRow = {}) {
    const row = {
      index1: 'workspace',
      blob1: 'app',
      blob2: 'env',
      blob3: 'pageview',
      blob4: "/a'b",
      blob5: '',
      blob6: '',
      blob7: 'session',
      blob8: 'visitor',
      blob9: 'new',
      blob10: 'www.google.com',
      blob11: 'email',
      blob12: 'hello',
      blob13: 'Email',
      blob14: 'Desktop',
      blob15: 'Firefox',
      blob16: 'IN',
      blob17: '/start',
      blob18: 'top',
      blob19: 'test',
      double1: 1,
      double2: reportNow - 1000,
      _sample_interval: 1,
      ...overrides,
    };
    database
      .prepare(
        `INSERT INTO app_health_browser_v1 (${Object.keys(row).join(',')}) VALUES (${Object.keys(
          row,
        )
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(row));
  }
  function seed() {
    add();
    add();
    add({
      blob4: '/other',
      blob16: '',
      blob13: '',
      blob14: '',
      blob15: '',
      blob17: '',
      blob10: '',
      blob6: '',
    });
    add({ blob4: '', blob16: 'Unknown' });
    add({ blob4: 'Unknown', blob16: 'Unknown' });
    add({ blob3: 'event', blob5: 'opened', double2: reportNow - 900 });
    add({ blob3: 'event', blob5: 'opened', double2: reportNow - 800 });
    add({ blob3: 'event', blob5: '', double2: reportNow - 700 });
    add({
      double2: reportNow - 90_000_000,
      blob7: 'previous',
      blob8: 'previous',
      blob9: 'returning',
    });
    add({ index1: 'foreign' });
    add({ blob1: 'foreign' });
    add({ blob2: 'foreign' });
    add({ double2: reportNow });
  }
  function provider(
    options: {
      first?: 'counter' | 'pages' | 'same';
      transform?: (sql: string, rows: Record<string, unknown>[]) => unknown;
      before?: (sql: string) => void;
    } = {},
  ) {
    const queries: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const sql = String(init?.body);
      queries.push(sql);
      options.before?.(sql);
      const data = database.prepare(sqliteAnalyticsSql(sql)).all();
      if (
        (options.first !== 'pages' && options.first !== 'same' && isPages(sql)) ||
        (options.first === 'pages' && isPeriods(sql))
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      return Response.json({ data: options.transform ? options.transform(sql, data) : data });
    });
    return { fetchImpl, queries };
  }
  return { database, add, seed, provider };
}

export function observable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(observable);
    return entries.every((row) => row && typeof row === 'object' && 'name' in row && 'count' in row)
      ? entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : entries;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, observable(item)]));
  return value;
}
