import { expect, it, vi } from 'vitest';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import { AppHealthService } from '../src/service.js';
import { handleProductEventIngest } from '../src/product-event-routes.js';
import type { ProductEnvironment } from '../src/product-event-model.js';
import { analysisDatabase } from './analysis-sqlite.js';

it('authenticates private event product/environment independently of browser and owner credentials', async () => {
  const repos = (await InMemoryAdapter.create()).asRepositories();
  const created = await new AppHealthService(repos).createApp(
    { name: 'Server', environment: 'production', key_scope: 'environment' },
    Date.now(),
  );
  const { db, sqlite } = analysisDatabase();
  sqlite
    .prepare('INSERT INTO apps(id,name,created_at) VALUES(?,?,?)')
    .run(created.app.id, 'Server', 1);
  sqlite
    .prepare('INSERT INTO environments(id,app_id,name,created_at) VALUES(?,?,?,?)')
    .run(created.environment.id, created.app.id, 'production', 1);
  sqlite.prepare('INSERT INTO workspace_apps VALUES(?,?)').run(created.app.id, 'ws');
  const input = {
    schema_version: 1,
    batch_id: crypto.randomUUID(),
    events: [
      {
        schemaVersion: 'app-health.product-event.v1',
        event_id: crypto.randomUUID(),
        channel: 'browser',
        type: 'event',
        name: 'Server Signup',
        occurred_at: Date.now(),
      },
    ],
  };
  const ingest = (
    body: unknown = input,
    headers: Record<string, string> = {},
    host = 'ingest.test',
    extra: Partial<ProductEnvironment> = {},
  ) =>
    handleProductEventIngest(
      new Request(`https://${host}/v1/product-events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${created.key.key}`, ...headers },
        body: JSON.stringify(body),
      }),
      { DB: db, APP_HEALTH_INGEST_HOST: 'ingest.test', ...extra },
      repos,
      false,
    );
  try {
    expect((await ingest(input, { origin: 'https://allowed-browser.test' }))?.status).toBe(403);
    expect((await ingest(input, { authorization: 'Bearer ahp_public' }))?.status).toBe(401);
    expect((await ingest(input, {}, 'dashboard.test'))?.status).toBe(404);
    expect((await ingest({ ...input, workspace_id: 'foreign' }))?.status).toBe(400);
    expect((await ingest({ ...input, environment_id: 'other-env' }))?.status).toBe(403);
    // Valid private input reaches durability checking; absent R2 cannot be acknowledged.
    expect((await ingest())?.status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 0,
    });
    const put = vi.fn(async () => ({}) as R2Object),
      get = vi.fn(async () => null);
    const noQueue = await ingest(input, {}, 'ingest.test', { BROWSER_HISTORY: { put, get } });
    expect(noQueue?.status).toBe(503);
    expect(await noQueue?.json()).toEqual({ error: 'Product maintenance queue unavailable' });
    expect(put).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM product_batches').get()).toMatchObject({
      n: 0,
    });
    const key = await repos.keys.verifyKey(created.key.key);
    await repos.keys.revokeKey(key!.id, Date.now());
    expect((await ingest())?.status).toBe(401);
  } finally {
    sqlite.close();
  }
});
