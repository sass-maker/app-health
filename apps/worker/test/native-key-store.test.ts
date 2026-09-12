import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { D1NativeKeyStore, MemoryNativeKeyStore } from '../src/native-key-store.js';
import type { D1DatabaseLike, D1PreparedStatement } from '../src/d1-adapter.js';

const scope = { workspace_id: 'workspace', app_id: 'app', environment_id: 'prod' };
class SQLiteD1 implements D1DatabaseLike {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string): D1PreparedStatement {
    const statement = this.db.prepare(sql);
    let values: never[] = [];
    return {
      bind(...next: unknown[]) {
        values = next as never[];
        return this;
      },
      async first<T>() {
        return (statement.get(...values) as T) ?? null;
      },
      async all<T>() {
        return { results: statement.all(...values) as T[] };
      },
      async run() {
        return { success: true, meta: { changes: Number(statement.run(...values).changes) } };
      },
    };
  }
  async batch(statements: D1PreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}
function fixture(kind: string) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE apps(id TEXT PRIMARY KEY); CREATE TABLE environments(id TEXT PRIMARY KEY); INSERT INTO apps VALUES ('app'); INSERT INTO environments VALUES ('prod');",
  );
  db.exec(readFileSync(new URL('../migrations/0010_native_keys.sql', import.meta.url), 'utf8'));
  return {
    db,
    store: kind === 'memory' ? new MemoryNativeKeyStore() : new D1NativeKeyStore(new SQLiteD1(db)),
  };
}
describe.each(['memory', 'd1'])('native key storage %s', (kind) => {
  it('stores only verifier hashes and isolates revocation to the exact scope', async () => {
    const { db, store } = fixture(kind);
    try {
      const issued = await store.create(scope);
      expect(issued.key).toMatch(/^ahk_native_[a-f0-9]{64}$/);
      expect(await store.resolve(issued.key)).toEqual(issued.record);
      if (kind === 'd1') {
        const rows = db.prepare('SELECT * FROM native_keys').all();
        expect(JSON.stringify(rows)).not.toContain(issued.key);
        expect(rows[0].verifier_hash).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(await store.revoke({ ...scope, workspace_id: 'other' }, issued.record.id)).toBe(false);
      expect(await store.list({ ...scope, environment_id: 'other' })).toEqual([]);
      expect(await store.revoke(scope, issued.record.id)).toBe(true);
      expect(await store.resolve(issued.key)).toBeNull();
      expect(await store.resolve('ahk_private')).toBeNull();
      expect(await store.resolve('ahk_native_' + '0'.repeat(64))).toBeNull();
    } finally {
      db.close();
    }
  });
  it('enforces the active limit under concurrent creation and bounds revoked history', async () => {
    const { db, store } = fixture(kind);
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () => store.create(scope)),
      );
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
      for (const row of await store.list(scope)) await store.revoke(scope, row.id);
      for (let i = 0; i < 25; i++) {
        const issued = await store.create(scope);
        await store.revoke(scope, issued.record.id);
      }
      expect(await store.list(scope)).toHaveLength(20);
      expect((await store.create(scope)).record.revoked_at).toBeNull();
      expect(await store.list(scope)).toHaveLength(21);
    } finally {
      db.close();
    }
  });
});
