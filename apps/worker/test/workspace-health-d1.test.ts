import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { D1ControlPlane } from '../src/d1-adapter.js';
import { D1EndpointWriter } from '../src/endpoint-durable.js';

describe('workspace health D1 aggregation', () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  let db: Awaited<ReturnType<typeof mf.getD1Database>>;

  beforeAll(async () => {
    db = await mf.getD1Database('DB');
    for (const file of [
      '0001_v0_initial.sql',
      '0002_observed_endpoint_inventory.sql',
      '0003_batch_dedupe.sql',
      '0004_product_keys.sql',
      '0005_log_events.sql',
      '0006_browser_logs.sql',
      '0007_accounts.sql',
      '0008_environment_capabilities.sql',
      '0013_archive_projects.sql',
      '0014_endpoint_rollups.sql',
      '0015_response_payload_bytes.sql',
    ]) {
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      for (const statement of sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .filter((candidate) => candidate.trim()))
        await db.prepare(statement).run();
    }
    for (const id of ['one', 'two']) {
      await db
        .prepare(
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
        )
        .bind(
          `user-${id}`,
          id,
          `${id}@example.com`,
          new Date().toISOString(),
          new Date().toISOString(),
        )
        .run();
      await db
        .prepare('INSERT INTO workspaces (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(`workspace-${id}`, `user-${id}`, id, Date.now())
        .run();
    }
  }, 30_000);

  afterAll(async () => mf.dispose());

  it('uses one scoped rollup and never leaks another workspace', async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const one = new D1ControlPlane(db, 'workspace-one');
    const two = new D1ControlPlane(db, 'workspace-two');
    const first = await one.createAppEnvironmentKey('Atlas', 'production', now - 100_000);
    const second = await two.createAppEnvironmentKey('Beacon', 'production', now - 100_000);
    await one
      .asRepositories({} as never)
      .capabilities!.recordCapability(
        first.app.id,
        first.environment.id,
        'endpoints',
        now - 60_000,
      );
    await two
      .asRepositories({} as never)
      .capabilities!.recordCapability(
        second.app.id,
        second.environment.id,
        'endpoints',
        now - 60_000,
      );
    const writer = new D1EndpointWriter(db);
    for (const [scope, id] of [
      [first, 'one'],
      [second, 'two'],
    ] as const) {
      await writer.accept(
        scope.app.id,
        scope.environment.id,
        'worker',
        'test',
        [
          {
            event_id: `event-${id}`,
            timestamp: now - 60_000,
            method: 'GET',
            route: '/health',
            status_code: 200,
            duration_ms: 25,
          },
        ],
        { now, batchId: `batch-${id}` },
      );
    }

    const response = await one.queryWorkspaceHealth(now + 30_000);
    expect(response.environments).toHaveLength(1);
    expect(response.environments[0]).toMatchObject({
      app_name: 'Atlas',
      environment_name: 'production',
      endpoints: {
        state: 'connected',
        metrics: { request_count: 1, error_count: 0, p95_ms: 25 },
      },
    });
  });
});
