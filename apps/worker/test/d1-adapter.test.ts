import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  D1ControlPlane,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1RunResult,
} from '../src/d1-adapter.js';

class Statement implements D1PreparedStatement {
  values: unknown[] = [];
  constructor(
    readonly sql: string,
    private readonly db: Database,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.db.firstError) throw this.db.firstError;
    return (this.db.firstResults.shift() as T | null | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: (this.db.allResults.shift() as T[] | undefined) ?? [] };
  }
  async run(): Promise<D1RunResult> {
    if (this.db.runError) throw this.db.runError;
    return this.db.runResults.shift() ?? { success: true, meta: { changes: 1 } };
  }
}

class Database implements D1DatabaseLike {
  statements: Statement[] = [];
  firstResults: unknown[] = [];
  allResults: unknown[][] = [];
  runResults: D1RunResult[] = [];
  batchResults: D1RunResult[] | null = null;
  firstError: Error | null = null;
  runError: Error | null = null;
  prepare(sql: string): D1PreparedStatement {
    const statement = new Statement(sql, this);
    this.statements.push(statement);
    return statement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return this.batchResults ?? statements.map(() => ({ success: true, meta: { changes: 1 } }));
  }
}

class SQLiteD1 implements D1DatabaseLike {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    const statement = this.sqlite.prepare(sql);
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
      async run() {
        const result = statement.run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }

  async batch(statements: D1PreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

describe('D1 control plane', () => {
  it('creates app, environment, hashed key, and installation state in one batch', async () => {
    const db = new Database();
    const created = await new D1ControlPlane(db).createAppEnvironmentKey('api', 'production', 100);
    expect(db.statements).toHaveLength(4);
    expect(db.statements.map((statement) => statement.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('INSERT INTO apps'),
        expect.stringContaining('INSERT INTO environments'),
        expect.stringContaining('INSERT INTO product_keys'),
        expect.stringContaining('INSERT INTO installation_status'),
      ]),
    );
    expect(created.rawKey).toMatch(/^ahk_/);
    expect(created.record.environment_id).toBeNull();
    expect(created.record.verifier_hash).not.toBe(created.rawKey);
    expect(JSON.stringify(db.statements.map((statement) => statement.values))).not.toContain(
      created.rawKey,
    );
  });

  it('fails the setup operation when any D1 batch statement fails', async () => {
    const db = new Database();
    db.batchResults = [
      { success: true, meta: { changes: 1 } },
      { success: false, meta: { changes: 0 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ];
    await expect(
      new D1ControlPlane(db).createAppEnvironmentKey('api', 'production', 100),
    ).rejects.toThrow('D1 setup transaction failed');
  });

  it('verifies only a non-revoked hashed key and never binds the raw key', async () => {
    const db = new Database();
    db.firstResults.push({
      id: 'key-1',
      app_id: 'app-1',
      environment_id: 'env-1',
      verifier_hash: 'stored',
      created_at: 1,
      revoked_at: null,
    });
    const record = await new D1ControlPlane(db).verifyKey('ahk_raw-secret');
    expect(record?.id).toBe('key-1');
    expect(db.statements[0].sql).toContain('revoked_at IS NULL');
    expect(db.statements[0].values[0]).not.toBe('ahk_raw-secret');
  });

  it('creates product keys and resolves one environment name per app', async () => {
    const db = new Database();
    const control = new D1ControlPlane(db);
    const created = await control.createProductKey('app-1', 100);
    expect(created.record.environment_id).toBeNull();
    expect(db.statements[0].sql).toContain('INSERT INTO product_keys');

    db.firstResults.push({
      id: 'env-local',
      app_id: 'app-1',
      name: 'local',
      created_at: 100,
    });
    await expect(control.resolveEnvironment('app-1', 'local', 100)).resolves.toMatchObject({
      id: 'env-local',
      app_id: 'app-1',
      name: 'local',
    });
    expect(db.statements[1].sql).toContain('WHERE NOT EXISTS');
    expect(db.statements[1].sql).toContain('COUNT(*)');
  });

  it('resolves concurrent same-name creates to one SQLite row', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(
      'CREATE TABLE environments (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    const control = new D1ControlPlane(new SQLiteD1(sqlite));
    const resolved = await Promise.all(
      Array.from({ length: 12 }, () => control.resolveEnvironment('app-1', 'local', 100)),
    );
    expect(new Set(resolved.map((environment) => environment?.id)).size).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM environments').get()).toMatchObject({
      count: 1,
    });
    sqlite.close();
  });

  it('returns null when the SQLite environment cap is already reached', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(
      'CREATE TABLE environments (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)',
    );
    const max = 20;
    const insert = sqlite.prepare('INSERT INTO environments VALUES (?, ?, ?, ?)');
    for (let index = 0; index < max; index += 1)
      insert.run(`env-${index}`, 'app-1', `env-${index}`, index);
    const resolved = await new D1ControlPlane(new SQLiteD1(sqlite)).resolveEnvironment(
      'app-1',
      'overflow',
      100,
    );
    expect(resolved).toBeNull();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM environments').get()).toMatchObject({
      count: max,
    });
    sqlite.close();
  });

  it('revokes active keys and propagates D1 write failures', async () => {
    const db = new Database();
    await new D1ControlPlane(db).revokeKey('key-1', 200);
    expect(db.statements[0].sql).toContain('revoked_at IS NULL');
    expect(db.statements[0].values).toEqual([200, 'key-1']);
    expect(db.statements[1].sql).toContain('UPDATE product_keys');

    const failing = new Database();
    failing.runError = new Error('injected D1 failure');
    await expect(new D1ControlPlane(failing).revokeKey('key-1', 200)).rejects.toThrow(
      'injected D1 failure',
    );
  });

  it('reports waiting, revoked, stale, and connected installation states', async () => {
    const now = 2_000_000;
    const cases = [
      [null, 'waiting'],
      [{ runtime: 'node', first_seen: 1, last_seen: 2, has_active_key: 0 }, 'revoked'],
      [{ runtime: 'go', first_seen: 1, last_seen: 1, has_active_key: 1 }, 'stale'],
      [
        { runtime: 'node', first_seen: now - 100, last_seen: now - 10, has_active_key: 1 },
        'connected',
      ],
    ] as const;
    for (const [row, expected] of cases) {
      const db = new Database();
      db.firstResults.push(row);
      await expect(new D1ControlPlane(db).getStatus('app-1', 'env-1', now)).resolves.toMatchObject({
        state: expected,
      });
    }
  });

  it('scopes dedupe claims, forgets failed claims, and bounds cleanup', async () => {
    const db = new Database();
    db.runResults.push(
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 0 } },
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 7 } },
    );
    const control = new D1ControlPlane(db);
    await expect(control.markSeen('app-1', 'env-1', 'batch-1', 100)).resolves.toBe(true);
    await expect(control.markSeen('app-1', 'env-1', 'batch-1', 101)).resolves.toBe(false);
    await control.forget('app-1', 'env-1', 'batch-1');
    await expect(control.cleanupExpired(50, 1000)).resolves.toBe(7);
    expect(db.statements[0].values).toEqual(['batch-1', 'app-1', 'env-1', 100]);
    expect(db.statements[2].values).toEqual(['app-1', 'env-1', 'batch-1']);
    expect(db.statements[3].values).toEqual([50, 1000]);
  });

  it('stores only a deduplicated normalized endpoint inventory', async () => {
    const db = new Database();
    const control = new D1ControlPlane(db);
    await control.recordObserved('app-1', 'env-1', [
      { method: 'GET', route: '/users/:id', timestamp: 100 },
      { method: 'GET', route: '/users/:id', timestamp: 200 },
      { method: 'POST', route: '/orders', timestamp: 150 },
    ]);

    expect(db.statements).toHaveLength(2);
    expect(db.statements[0].sql).toContain('INSERT INTO observed_endpoints');
    expect(db.statements[0].values).toEqual(['app-1', 'env-1', 'GET', '/users/:id', 100, 200]);
    expect(JSON.stringify(db.statements.map(({ sql, values }) => ({ sql, values })))).not.toMatch(
      /status_code|duration_ms|payload|headers/,
    );

    db.allResults.push([{ method: 'GET', route: '/users/:id', first_seen: 100, last_seen: 200 }]);
    await expect(control.listObserved('app-1', 'env-1')).resolves.toEqual([
      { method: 'GET', route: '/users/:id', first_seen: 100, last_seen: 200 },
    ]);
    expect(db.statements.at(-1)?.values).toEqual(['app-1', 'env-1']);
  });

  it('lists only scoped recent failures with a server-provided bound', async () => {
    const db = new Database();
    db.allResults.push([
      {
        failure_id: 'failure-1',
        method: 'POST',
        route: '/orders/:id',
        status_code: 503,
        duration_ms: 912,
        occurred_at: 200,
        release: '2026.07.22',
      },
    ]);
    const failures = await new D1ControlPlane(db).listFailures('app-1', 'env-1', 100, 50);
    expect(failures).toHaveLength(1);
    expect(db.statements[0].sql).toContain('FROM failure_events');
    expect(db.statements[0].sql).toContain('app_id = ? AND environment_id = ?');
    expect(db.statements[0].sql).toContain('occurred_at >= ?');
    expect(db.statements[0].sql).not.toMatch(/headers|query|body|identity/);
    expect(db.statements[0].values).toEqual(['app-1', 'env-1', 100, 50]);
  });
});
