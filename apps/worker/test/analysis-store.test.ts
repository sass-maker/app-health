import { expect, it } from 'vitest';
import { D1AnalysisStore, LocalAnalysisStore } from '../src/analysis-store.js';
import { analysisDatabase } from './analysis-sqlite.js';

const scope = { workspace: 'ws', app_id: 'app', environment_id: 'env' };
const definition = {
  kind: 'goal' as const,
  name: 'Pricing',
  step: { type: 'page' as const, target: '/pricing' },
};
it('persists, updates and removes scoped definitions with real replayed SQLite migrations', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    const store = new D1AnalysisStore(db);
    const created = await store.save(scope, definition);
    expect(created?.definition).toEqual(definition);
    expect(await store.list(scope)).toEqual([created]);
    expect(await store.list({ ...scope, workspace: 'other' })).toEqual([]);
    expect(await store.save({ ...scope, workspace: 'other' }, definition, created!.id)).toBeNull();
    const updated = await store.save(scope, { ...definition, name: 'New name' }, created!.id);
    expect(updated).toMatchObject({
      id: created!.id,
      created_at: created!.created_at,
      definition: { name: 'New name' },
    });
    expect(await store.remove({ ...scope, environment_id: 'other-env' }, created!.id)).toBe(false);
    expect(await store.remove(scope, created!.id)).toBe(true);
    expect(await store.list(scope)).toEqual([]);
    expect(await store.save(scope, definition, crypto.randomUUID())).toBeNull();
  } finally {
    sqlite.close();
  }
});
it('enforces ownership, environment association, immutable scope and concurrent-safe definition caps in SQL', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    const store = new D1AnalysisStore(db);
    await expect(
      store.save({ ...scope, app_id: 'other-app', environment_id: 'other-env' }, definition),
    ).rejects.toThrow('scope mismatch');
    await expect(store.save({ ...scope, environment_id: 'other-env' }, definition)).rejects.toThrow(
      'FOREIGN KEY',
    );
    const first = await store.save(scope, definition);
    expect(() =>
      sqlite
        .prepare("UPDATE analytics_definitions SET workspace_id = 'elsewhere' WHERE id = ?")
        .run(first!.id),
    ).toThrow('immutable');
    for (let index = 1; index < 100; index++) await store.save(scope, definition);
    expect(await store.list(scope)).toHaveLength(100);
    await expect(store.save(scope, definition)).rejects.toThrow('limit reached');
    expect(
      sqlite.prepare('SELECT COUNT(*) AS total FROM analytics_definitions').get(),
    ).toMatchObject({ total: 100 });
    sqlite.exec(
      "UPDATE analytics_definitions SET definition_json = '{}' WHERE rowid = (SELECT MIN(rowid) FROM analytics_definitions)",
    );
    await expect(store.list(scope)).rejects.toThrow();
  } finally {
    sqlite.close();
  }
});
it('keeps credential-free local definitions isolated and bounded with matching update/delete semantics', async () => {
  const store = new LocalAnalysisStore();
  const record = await store.save(scope, definition);
  expect(await store.list({ ...scope, workspace: 'other' })).toEqual([]);
  expect(await store.save(scope, definition, crypto.randomUUID())).toBeNull();
  expect(await store.save(scope, { ...definition, name: 'Updated' }, record!.id)).toMatchObject({
    id: record!.id,
    definition: { name: 'Updated' },
  });
  expect(await store.remove(scope, record!.id)).toBe(true);
  expect(await store.remove(scope, record!.id)).toBe(false);
  for (let index = 0; index < 100; index++) await store.save(scope, definition);
  await expect(store.save(scope, definition)).rejects.toThrow('limit reached');
});
