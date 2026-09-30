// Regression probe for issue sass-maker/app-health#92.
// Counts D1 round-trips for the GET /v1/apps and GET /v1/capabilities read
// paths under a 55-product workspace, using a real SQLite-backed D1.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it } from 'vitest';
import { D1ControlPlane, getAccountCapabilitySetup } from '../src/d1-adapter.js';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';

interface Counters {
  prepareCalls: number;
  batchCalls: number;
  // True D1 network round-trips: direct first/all/run + batch calls.
  roundTrips: number;
}

function makeCountingDb(sql: DatabaseSync, counters: Counters): D1DatabaseLike {
  let inBatch = false;
  const wrap = (stmt: ReturnType<DatabaseSync['prepare']>, query: string) => {
    let values: unknown[] = [];
    const prepared: D1PreparedStatement & { __query: string } = {
      __query: query,
      bind(...args: unknown[]) {
        values = args;
        return this;
      },
      async first<T>() {
        if (!inBatch) counters.roundTrips += 1;
        return (stmt.get(...(values as never[])) ?? null) as T | null;
      },
      async all<T>() {
        if (!inBatch) counters.roundTrips += 1;
        return { results: stmt.all(...(values as never[])) as T[] };
      },
      async run() {
        if (!inBatch) counters.roundTrips += 1;
        const result = stmt.run(...(values as never[]));
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  };
  return {
    prepare(query: string) {
      counters.prepareCalls += 1;
      return wrap(sql.prepare(query), query);
    },
    async batch(statements: D1PreparedStatement[]) {
      counters.batchCalls += 1;
      counters.roundTrips += 1;
      inBatch = true;
      try {
        const results = await Promise.all(
          statements.map(async (statement) => {
            const query = (statement as { __query?: string }).__query ?? '';
            if (/^\s*SELECT/i.test(query)) {
              const rows = await (statement as D1PreparedStatement).all();
              return { success: true, meta: { changes: 0 }, results: rows.results };
            }
            return statement.run();
          }),
        );
        return results as D1RunResult[];
      } finally {
        inBatch = false;
      }
    },
  };
}

function applyMigrations(sql: DatabaseSync) {
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((n) => n.endsWith('.sql'))
    .sort()) {
    sql.exec(readFileSync(new URL(file, directory), 'utf8'));
  }
}

function seed55(sql: DatabaseSync) {
  const ws = 'ws-probe';
  sql
    .prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    )
    .run('owner-probe', 'Probe', 'probe@example.test');
  sql
    .prepare('INSERT INTO workspaces (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)')
    .run(ws, 'owner-probe', 'Probe', 1);
  const insertApp = sql.prepare('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)');
  const insertEnv = sql.prepare(
    'INSERT INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)',
  );
  const insertKey = sql.prepare(
    'INSERT INTO keys (id, app_id, environment_id, verifier_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)',
  );
  const insertCap = sql.prepare(
    'INSERT INTO environment_capabilities (app_id, environment_id, capability, enabled, first_received_at, last_received_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const linkApp = sql.prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)');
  for (let i = 0; i < 55; i += 1) {
    const appId = `app-${i}`;
    insertApp.run(appId, `Product ${i}`, i);
    linkApp.run(appId, ws);
    const envCount = i % 3 === 0 ? 2 : 1;
    for (let e = 0; e < envCount; e += 1) {
      const envId = `env-${i}-${e}`;
      insertEnv.run(envId, appId, e === 0 ? 'production' : 'staging', i * 10 + e);
      insertKey.run(`key-${i}-${e}`, appId, envId, `hash-${i}-${e}`, i * 10 + e);
      insertCap.run(appId, envId, 'endpoints', 1, i, i + 100);
    }
  }
  return ws;
}

it('GET /v1/apps: combined listAppsAndEnvironments is 1 round-trip and equals the 2-call path', async () => {
  const sql = new DatabaseSync(':memory:');
  applyMigrations(sql);
  const ws = seed55(sql);

  // Baseline: the original 2-call path (listApps + listEnvironmentsForApps).
  const baseCounters: Counters = { prepareCalls: 0, batchCalls: 0, roundTrips: 0 };
  const baseControl = new D1ControlPlane(makeCountingDb(sql, baseCounters), ws);
  const baseRepos = baseControl.asRepositories({
    async queryEndpointBuckets() {
      return [];
    },
  } as never);
  const baseApps = await baseRepos.apps.listApps();
  const baseEnvs = await baseRepos.environments.listEnvironmentsForApps(baseApps.map((a) => a.id));
  const baseByApp = new Map<string, typeof baseEnvs>();
  for (const environment of baseEnvs) {
    const group = baseByApp.get(environment.app_id) ?? [];
    group.push(environment);
    baseByApp.set(environment.app_id, group);
  }
  const baseline = baseApps.map((app) => ({
    app_id: app.id,
    environments: (baseByApp.get(app.id) ?? []).map((e) => e.id),
  }));

  // New: single combined read.
  const newCounters: Counters = { prepareCalls: 0, batchCalls: 0, roundTrips: 0 };
  const newControl = new D1ControlPlane(makeCountingDb(sql, newCounters), ws);
  const newRepos = newControl.asRepositories({
    async queryEndpointBuckets() {
      return [];
    },
  } as never);
  const combined = await newRepos.apps.listAppsAndEnvironments!();
  const combinedView = combined.map((entry) => ({
    app_id: entry.app.id,
    environments: entry.environments.map((e) => e.id),
  }));

  expect(combined).toHaveLength(55);
  expect(combinedView).toEqual(baseline);
  expect(newCounters.roundTrips).toBe(1);
  expect(baseCounters.roundTrips).toBe(2);
  console.log(
    `listApps 2-call roundTrips=${baseCounters.roundTrips} | combined roundTrips=${newCounters.roundTrips}`,
  );
  sql.close();
});

it('counts D1 round-trips for GET /v1/capabilities getCapabilitySetup', async () => {
  const sql = new DatabaseSync(':memory:');
  applyMigrations(sql);
  const ws = seed55(sql);
  const counters: Counters = {
    prepareCalls: 0,
    batchCalls: 0,
    roundTrips: 0,
  };
  const db = makeCountingDb(sql, counters);
  const control = new D1ControlPlane(db, ws);
  const repos = control.asRepositories({
    async queryEndpointBuckets() {
      return [];
    },
  } as never);
  const setup = await repos.capabilitySetup?.getCapabilitySetup('app-0', 'env-0-0');
  expect(setup).not.toBeNull();
  expect(counters.batchCalls).toBe(1);
  expect(counters.roundTrips).toBe(1);
  console.log(
    `getCapabilitySetup: prepareCalls=${counters.prepareCalls} batchCalls=${counters.batchCalls} roundTrips=${counters.roundTrips}`,
  );
  sql.close();
});

it('joins an already-resolved account scope and capability setup in one D1 round-trip', async () => {
  const sql = new DatabaseSync(':memory:');
  applyMigrations(sql);
  const workspaceId = seed55(sql);
  const counters: Counters = { prepareCalls: 0, batchCalls: 0, roundTrips: 0 };
  const db = makeCountingDb(sql, counters);

  const joined = await getAccountCapabilitySetup(db, 'owner-probe', 'app-1', 'env-1-0');
  expect(joined).not.toBeNull();
  expect(joined).toMatchObject({
    workspace: { id: workspaceId },
    appIds: ['app-1'],
    setup: {
      capabilities: [
        { id: 'analytics', enabled: false, first_received_at: null, last_received_at: null },
        { id: 'endpoints', enabled: true, first_received_at: 1, last_received_at: 101 },
        { id: 'logs', enabled: false, first_received_at: null, last_received_at: null },
      ],
    },
  });
  expect(counters.roundTrips).toBe(1);
  expect(counters.batchCalls).toBe(0);
  sql.close();
});
