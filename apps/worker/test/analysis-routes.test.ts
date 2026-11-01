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
  const call = (
    path: string,
    method = 'GET',
    body?: unknown,
    identity = owner,
    local = true,
    env: unknown = {},
  ) =>
    handleAnalysisOwner(
      new Request(`http://local${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      }),
      env as never,
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

it('returns only static conversion failure categories while preserving error status and copy', async () => {
  const f = await fixture();
  const path = `/v1/analytics/conversions?${f.scope}&range=24h`;
  const failure = (message: string) => ({
    DB: {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error(message);
          },
        }),
      }),
    },
  });
  const request = async (message: string) => {
    const response = (await f.call(
      path,
      'GET',
      undefined,
      { ...f.owner, workspaceId: 'w' },
      false,
      failure(message),
    ))!;
    expect(response.status).toBe(503);
    return (await response.json()) as Record<string, unknown>;
  };
  const publicError =
    'Analysis unavailable. Reduce the period or retry after archive processing; no complete result is claimed.';

  expect(await request('Conversion scan limit exceeded; choose a shorter period.')).toEqual({
    error: publicError,
    reason: 'work_limit',
  });
  expect(await request('Conversion scan time limit exceeded; choose a shorter period.')).toEqual({
    error: publicError,
    reason: 'deadline',
  });
  expect(await request('checksum mismatch')).toEqual({
    error: publicError,
    reason: 'archive_integrity',
  });
  expect(await request('Conversion archive unavailable')).toEqual({
    error: publicError,
    reason: 'source_unavailable',
  });

  const privateMessage = 'untrusted provider response with customer data';
  const unknown = await request(privateMessage);
  expect(unknown).toEqual({ error: publicError, reason: 'unknown' });
  expect(JSON.stringify(unknown)).not.toContain(privateMessage);
});

it('does not add conversion reasons to forbidden-scope or invalid-query responses', async () => {
  const f = await fixture();
  const forbidden = (await f.call(
    `/v1/analytics/conversions?${f.scope}&range=24h`,
    'GET',
    undefined,
    { ...f.owner, appIds: [] },
  ))!;
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toEqual({
    error: 'Analysis project or environment scope forbidden',
  });

  const invalid = (await f.call(`/v1/analytics/conversions?${f.scope}&range=all`))!;
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toEqual({ error: 'Invalid analysis query' });

  const reportUnavailable = (await f.call(
    `/v1/analytics/conversions?${f.scope}&range=24h`,
    'GET',
    undefined,
    f.owner,
    false,
  ))!;
  expect(reportUnavailable.status).toBe(503);
  expect(await reportUnavailable.json()).toEqual({
    error: 'Analysis storage unavailable',
    reason: 'source_unavailable',
  });

  const definitionsUnavailable = (await f.call(
    `/v1/analytics/definitions?${f.scope}`,
    'GET',
    undefined,
    f.owner,
    false,
  ))!;
  expect(definitionsUnavailable.status).toBe(503);
  expect(await definitionsUnavailable.json()).toEqual({ error: 'Analysis storage unavailable' });
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

it('reports the saved-definition limit explicitly without losing existing definitions', async () => {
  const f = await fixture();
  const path = `/v1/analytics/definitions?${f.scope}`;
  for (let index = 0; index < 100; index++)
    expect(
      (await f.call(path, 'POST', {
        kind: 'goal',
        name: `Goal ${index}`,
        step: { type: 'page', target: '/' },
      }))!.status,
    ).toBe(201);
  const rejected = (await f.call(path, 'POST', {
    kind: 'goal',
    name: 'Overflow',
    step: { type: 'page', target: '/' },
  }))!;
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('100') });
  expect(((await (await f.call(path))!.json()) as { records: unknown[] }).records).toHaveLength(
    100,
  );
});
