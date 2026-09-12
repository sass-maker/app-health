import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { cleanupExpiredAccountRecords } from '../src/account-retention.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

function fakeDb(results = [2, 3, 4]): {
  db: D1DatabaseLike;
  queries: string[];
  binds: unknown[][];
} {
  const queries: string[] = [];
  const binds: unknown[][] = [];
  const db: D1DatabaseLike = {
    prepare(query) {
      queries.push(query);
      const statement: D1PreparedStatement = {
        bind(...values) {
          binds.push(values);
          return statement;
        },
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: {} }),
      };
      return statement;
    },
    batch: async () => results.map((changes) => ({ success: true, meta: { changes } })),
  };
  return { db, queries, binds };
}

describe('cleanupExpiredAccountRecords', () => {
  it('removes expired ISO rows and retains future rows in SQLite', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(
      'CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt DATE NOT NULL); CREATE TABLE verification (id TEXT PRIMARY KEY, expiresAt DATE NOT NULL); CREATE TABLE rateLimit (id TEXT PRIMARY KEY, lastRequest BIGINT NOT NULL);',
    );
    const expired = new Date(1_700_000_000_000 - 1000).toISOString();
    const future = new Date(1_700_000_000_000 + 60_000).toISOString();
    sqlite
      .prepare('INSERT INTO session VALUES (?, ?), (?, ?)')
      .run('old-session', expired, 'new-session', future);
    sqlite
      .prepare('INSERT INTO verification VALUES (?, ?), (?, ?)')
      .run('old-verification', expired, 'new-verification', future);
    sqlite
      .prepare('INSERT INTO rateLimit VALUES (?, ?), (?, ?)')
      .run('old-limit', 1_699_999_000_000, 'new-limit', 1_700_000_000_000);
    const db: D1DatabaseLike = {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let values: unknown[] = [];
        const d1Statement: D1PreparedStatement = {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first<T>() {
            return (statement.get(...(values as never[])) as T | undefined) ?? null;
          },
          async all<T>() {
            return { results: statement.all(...(values as never[])) as T[] };
          },
          async run() {
            const result = statement.run(...(values as never[]));
            return { success: true, meta: { changes: Number(result.changes) } };
          },
        };
        return d1Statement;
      },
      async batch(statements) {
        return Promise.all(statements.map((statement) => statement.run()));
      },
    };
    await expect(cleanupExpiredAccountRecords(db, 1_700_000_000_000)).resolves.toMatchObject({
      ok: true,
      sessions: 1,
      verifications: 1,
      rateLimits: 1,
    });
    expect(sqlite.prepare('SELECT id FROM session').all()).toEqual([{ id: 'new-session' }]);
    expect(sqlite.prepare('SELECT id FROM verification').all()).toEqual([
      { id: 'new-verification' },
    ]);
    expect(sqlite.prepare('SELECT id FROM rateLimit').all()).toEqual([{ id: 'new-limit' }]);
    sqlite.close();
  });

  it('deletes only expired account support rows with numeric and text date handling', async () => {
    const { db, queries, binds } = fakeDb();
    const result = await cleanupExpiredAccountRecords(db, 1_700_000_000_000, 5000);
    expect(result).toEqual({ ok: true, sessions: 2, verifications: 3, rateLimits: 4 });
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('DELETE FROM session');
    expect(queries[1]).toContain('DELETE FROM verification');
    expect(queries[2]).toContain('DELETE FROM rateLimit');
    expect(queries[0]).toContain("typeof(expiresAt) IN ('integer', 'real')");
    expect(queries[0]).toContain('CAST(expiresAt AS REAL)');
    expect(queries[1]).toContain('julianday(expiresAt)');
    expect(queries.every((query) => !/DELETE FROM (user|account)/i.test(query))).toBe(true);
    expect(binds).toEqual([
      [1_700_000_000, 1000],
      [1_700_000_000, 1000],
      [1_699_999_940_000, 1000],
    ]);
  });

  it('returns a sanitized failure when the bounded batch fails', async () => {
    const { db } = fakeDb();
    db.batch = async () => {
      throw new Error('database details must not escape');
    };
    await expect(cleanupExpiredAccountRecords(db)).resolves.toEqual({
      ok: false,
      sessions: 0,
      verifications: 0,
      rateLimits: 0,
      error: 'account retention cleanup failed',
    });
  });
});
