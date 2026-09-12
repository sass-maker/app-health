import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';
import {
  AnalyticsShareLimitError,
  D1AnalyticsShareStore,
  MemoryAnalyticsShareStore,
  type AnalyticsShareStore,
  type ShareScope,
} from '../src/analytics-share-store.js';

class SQLiteD1 implements D1DatabaseLike {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(query: string): D1PreparedStatement {
    const db = this.sqlite;
    const statement = this.sqlite.prepare(query);
    let values: unknown[] = [];
    return {
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
      async run(): Promise<D1RunResult> {
        statement.run(...(values as never[]));
        const changes = db.prepare('SELECT changes() AS count').get() as { count: number };
        return {
          success: true,
          meta: { changes: Number(changes.count) },
        };
      },
    } as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1RunResult[]> {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const scope: ShareScope = { workspace: 'workspace-a', app_id: 'app-a', environment_id: 'prod' };
const otherScope: ShareScope = { ...scope, workspace: 'workspace-b' };

async function migration(db: DatabaseSync) {
  const sql = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '../migrations/0009_analytics_shares.sql'),
    'utf8',
  );
  db.exec(sql);
}

async function stores(): Promise<{
  store: AnalyticsShareStore;
  db: DatabaseSync;
  close: () => void;
}> {
  const db = new DatabaseSync(':memory:');
  await migration(db);
  return { store: new D1AnalyticsShareStore(new SQLiteD1(db)), db, close: () => db.close() };
}

describe.each(['memory', 'd1'])('analytics share store (%s)', (kind) => {
  let store: AnalyticsShareStore;
  let db: DatabaseSync | undefined;
  let close = () => {};
  beforeEach(async () => {
    if (kind === 'memory') store = new MemoryAnalyticsShareStore();
    else ({ store, db, close } = await stores());
  });

  it('returns a high entropy token while persisting only its hash', async () => {
    const created = await store.create(scope);
    expect(created.token).toMatch(/^ahs_[A-Za-z0-9_-]{43}$/);
    expect(await store.resolve(created.token)).toMatchObject({ id: created.share.id, ...scope });
    if (kind === 'd1') {
      const row = db!.prepare('SELECT token_hash FROM analytics_shares').get() as {
        token_hash: string;
      };
      expect(row.token_hash).not.toContain(created.token);
      expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    close();
  });

  it('isolates scopes and revokes idempotently', async () => {
    const created = await store.create(scope);
    expect(await store.list(otherScope)).toEqual([]);
    expect(await store.revoke(otherScope, created.share.id)).toBe(false);
    expect(await store.revoke(scope, created.share.id)).toBe(true);
    expect(await store.revoke(scope, created.share.id)).toBe(true);
    expect(await store.resolve(created.token)).toBeNull();
    close();
  });

  it('enforces five active links under concurrency', async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.create(scope)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(
      results
        .filter((result) => result.status === 'rejected')
        .every((result) => result.reason instanceof AnalyticsShareLimitError),
    ).toBe(true);
    expect((await store.list(scope)).filter((share) => share.revoked_at === null)).toHaveLength(5);
    close();
  });

  it('bounds revoked history without deleting active links', async () => {
    const created: { share: { id: string }; token: string }[] = [];
    for (let index = 0; index < 25; index += 1) {
      const share = await store.create(scope);
      created.push(share);
      await store.revoke(scope, share.share.id);
    }
    const active = await store.create(scope);
    expect(await store.resolve(active.token)).toMatchObject({ id: active.share.id });
    expect(
      (await store.list(scope)).filter((share) => share.revoked_at !== null).length,
    ).toBeLessThanOrEqual(20);
    close();
  });

  it('keeps an old active link listable and revocable after history churn', async () => {
    const active = await store.create(scope);
    for (let index = 0; index < 25; index += 1) {
      const created = await store.create(scope);
      await store.revoke(scope, created.share.id);
    }
    expect((await store.list(scope)).some((share) => share.id === active.share.id)).toBe(true);
    expect(await store.revoke(scope, active.share.id)).toBe(true);
    expect(await store.resolve(active.token)).toBeNull();
    close();
  });

  it('rejects malformed tokens before lookup', async () => {
    expect(await store.resolve('ahk_' + 'a'.repeat(64))).toBeNull();
    close();
  });
});
