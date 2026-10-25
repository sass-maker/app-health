import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { URL } from 'node:url';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';

export function analysisDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(name, migrations), 'utf8'));
  sqlite.exec(`INSERT INTO "user" VALUES ('user', 'Owner', 'owner@example.test', 1, NULL, 1, 1);
    INSERT INTO workspaces VALUES ('ws', 'user', 'Workspace', 1);
    INSERT INTO apps(id, name, created_at) VALUES ('app', 'Product', 1), ('other-app', 'Other product', 1);
    INSERT INTO environments(id, app_id, name, created_at) VALUES ('env', 'app', 'production', 1), ('other-env', 'other-app', 'production', 1);
    INSERT INTO workspace_apps VALUES ('app', 'ws');`);
  class Statement implements D1PreparedStatement {
    private values: SQLInputValue[] = [];
    constructor(private sql: string) {}
    bind(...values: unknown[]) {
      this.values = values as SQLInputValue[];
      return this;
    }
    async all<T>() {
      return {
        results: sqlite
          .prepare(this.sql)
          .all(...this.values)
          .map((row) => ({ ...row })) as T[],
      };
    }
    async first<T>() {
      return (await this.all<T>()).results[0] ?? null;
    }
    async run(): Promise<D1RunResult> {
      if (/^\s*SELECT|RETURNING\b/i.test(this.sql))
        return {
          success: true,
          meta: {},
          results: (await this.all<Record<string, unknown>>()).results,
        };
      return {
        success: true,
        meta: { changes: Number(sqlite.prepare(this.sql).run(...this.values).changes) },
      };
    }
  }
  const db: D1DatabaseLike = {
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, sqlite };
}
