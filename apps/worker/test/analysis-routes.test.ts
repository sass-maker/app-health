import { expect, it } from 'vitest';
import { AnalysisReport } from '@app-health/contracts';
import { handleAnalysisOwner } from '../src/analysis-routes.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import { AppHealthService } from '../src/service.js';
import type { OwnerIdentity } from '../src/identity.js';

async function fixture() {
  const repos = (await InMemoryAdapter.create()).asRepositories();
  const created = await new AppHealthService(repos).createApp(
    { name: 'Conversions', environment: 'production', key_scope: 'environment' },
    Date.now(),
  );
  const scope = `app_id=${created.app.id}&environment_id=${created.environment.id}`;
  const owner: OwnerIdentity = { id: 'owner', label: 'Owner', appIds: [created.app.id] };
  const call = (path: string, method = 'GET', body?: unknown, identity = owner, local = true) =>
    handleAnalysisOwner(
      new Request(`http://local${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
      {},
      identity,
      repos,
      local,
    );
  return { call, scope, owner, created };
}
it('provides create/list/edit/delete goals and funnels with local report provenance', async () => {
  const f = await fixture();
  const path = `/v1/analytics/definitions?${f.scope}`;
  const definition = { kind: 'goal', name: 'Pricing', step: { type: 'page', target: '/pricing' } };
  const saved = (await f.call(path, 'POST', definition))!;
  expect(saved.status).toBe(201);
  const record = (await saved.json()) as { id: string };
  expect((await (await f.call(path))!.json()) as unknown).toMatchObject({
    records: [{ id: record.id }],
  });
  expect(
    (await f.call(`/v1/analytics/definitions/${record.id}?${f.scope}`, 'PUT', {
      ...definition,
      name: 'Changed',
    }))!.status,
  ).toBe(200);
  const report = AnalysisReport.parse(
    await (await f.call(`/v1/analytics/conversions?${f.scope}&range=1h`))!.json(),
  );
  expect(report).toMatchObject({
    source: 'local',
    complete: true,
    goals: [{ name: 'Changed', conversion_rate: null }],
  });
  expect(
    (await f.call(`/v1/analytics/definitions/${record.id}?${f.scope}`, 'DELETE'))!.status,
  ).toBe(200);
  expect(
    (await f.call(`/v1/analytics/definitions/${record.id}?${f.scope}`, 'PUT', definition))!.status,
  ).toBe(404);
  expect(
    (await f.call(`/v1/analytics/definitions/${record.id}?${f.scope}`, 'DELETE'))!.status,
  ).toBe(404);
});
it('rejects invalid JSON/definitions, oversized bodies, unsupported methods and foreign project/environment scope', async () => {
  const f = await fixture();
  const path = `/v1/analytics/definitions?${f.scope}`;
  expect(await f.call('/unrelated')).toBeNull();
  expect((await f.call(path, 'POST', '{'))!.status).toBe(400);
  expect((await f.call(path, 'POST', {}))!.status).toBe(400);
  expect((await f.call(path, 'POST', 'x'.repeat(16385)))!.status).toBe(413);
  expect((await f.call(path, 'PATCH'))!.status).toBe(405);
  expect((await f.call('/v1/analytics/definitions'))!.status).toBe(400);
  expect((await f.call(path, 'GET', undefined, { ...f.owner, appIds: [] }))!.status).toBe(403);
  expect((await f.call(path.replace(f.created.environment.id, 'missing')))!.status).toBe(403);
  expect((await f.call(`/v1/analytics/conversions?${f.scope}`, 'POST'))!.status).toBe(405);
  expect((await f.call(`/v1/analytics/conversions?${f.scope}&filters=bad`))!.status).toBe(400);
  expect((await f.call(`/v1/analytics/conversions?${f.scope}&range=all`))!.status).toBe(400);
  expect((await f.call(path, 'GET', undefined, f.owner, false))!.status).toBe(503);
});
