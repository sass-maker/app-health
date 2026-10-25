import { expect, it } from 'vitest';
import {
  acceptInvite,
  apiTokenIdentity,
  createApiToken,
  createInvite,
  listWorkspaces,
  selectedMembership,
} from '../src/workspace-access.js';
import { ownerRouteAllowed } from '../src/access-policy.js';
import { handleWorkspaceAccess } from '../src/workspace-routes.js';
import { handleAnalyticsMcp, integrationSkill } from '../src/analytics-mcp.js';
import { analysisDatabase } from './analysis-sqlite.js';
import type { OwnerIdentity } from '../src/identity.js';

const owner: OwnerIdentity = {
  id: 'user',
  label: 'Owner',
  email: 'owner@example.test',
  authKind: 'account',
  workspaceRole: 'owner',
  workspaceId: 'ws',
  appIds: ['app'],
};
function fixture() {
  const database = analysisDatabase();
  database.sqlite
    .exec(`INSERT INTO "user" VALUES ('guest', 'Guest', 'guest@example.test', 1, NULL, 1, 1);
    INSERT INTO "user" VALUES ('stranger', 'Stranger', 'stranger@example.test', 1, NULL, 1, 1);`);
  return database;
}

it('binds one-time invitations to a verified email and expiry, preserves roles and never resurrects removed members', async () => {
  const { db, sqlite } = fixture();
  try {
    const guest = { ...owner, id: 'guest', email: 'guest@example.test', workspaceId: 'personal' };
    const invitation = await createInvite(db, owner, {
      email: 'GUEST@example.test',
      role: 'viewer',
    });
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM workspace_invites').all())).not.toContain(
      invitation.token,
    );
    expect(
      await acceptInvite(db, { ...guest, email: 'stranger@example.test' }, invitation.token),
    ).toBeNull();
    expect(await selectedMembership(db, guest.id, 'ws')).toBeNull();
    expect(await acceptInvite(db, guest, invitation.token)).toBe('ws');
    expect(await acceptInvite(db, guest, invitation.token)).toBe('ws');
    expect(await selectedMembership(db, guest.id, 'ws')).toMatchObject({ role: 'viewer' });
    expect(await listWorkspaces(db, guest.id)).toHaveLength(1);
    sqlite.exec("UPDATE workspace_members SET role='editor' WHERE user_id='guest'");
    const lower = await createInvite(db, owner, { email: guest.email, role: 'viewer' });
    expect(await acceptInvite(db, guest, lower.token)).toBe('ws');
    expect(await selectedMembership(db, guest.id, 'ws')).toMatchObject({ role: 'editor' });
    sqlite.exec("DELETE FROM workspace_members WHERE user_id='guest'");
    expect(await acceptInvite(db, guest, invitation.token)).toBeNull();
    expect(await acceptInvite(db, guest, lower.token)).toBeNull();
    const expired = await createInvite(db, owner, { email: guest.email, role: 'editor' });
    sqlite.exec(`UPDATE workspace_invites SET expires_at=1 WHERE id='${expired.id}'`);
    expect(await acceptInvite(db, guest, expired.token)).toBeNull();
    const revoked = await createInvite(db, owner, { email: guest.email, role: 'viewer' });
    sqlite.exec(`UPDATE workspace_invites SET revoked_at=1 WHERE id='${revoked.id}'`);
    expect(await acceptInvite(db, guest, revoked.token)).toBeNull();
    await expect(createInvite(db, owner, { email: guest.email, role: 'owner' })).rejects.toThrow();
  } finally {
    sqlite.close();
  }
});

it('upgrades an existing viewer through an editor invitation even at the member cap, without downgrades', async () => {
  const { db, sqlite } = fixture();
  try {
    const guest = { ...owner, id: 'guest', email: 'guest@example.test' };
    sqlite.exec("INSERT INTO workspace_members VALUES ('ws','guest','viewer',1)");
    for (let index = 0; index < 98; index++) {
      sqlite
        .prepare('INSERT INTO "user" VALUES (?,?,?,1,NULL,1,1)')
        .run(`member-${index}`, 'Member', `member-${index}@example.test`);
      sqlite
        .prepare("INSERT INTO workspace_members VALUES ('ws',?,'viewer',1)")
        .run(`member-${index}`);
    }
    const upgrade = await createInvite(db, owner, { email: guest.email, role: 'editor' });
    expect(await acceptInvite(db, guest, upgrade.token)).toBe('ws');
    expect(await selectedMembership(db, guest.id, 'ws')).toMatchObject({ role: 'editor' });
    const lower = await createInvite(db, owner, { email: guest.email, role: 'viewer' });
    expect(await acceptInvite(db, guest, lower.token)).toBe('ws');
    expect(await selectedMembership(db, guest.id, 'ws')).toMatchObject({ role: 'editor' });
    const blocked = await createInvite(db, owner, {
      email: 'stranger@example.test',
      role: 'editor',
    });
    expect(
      await acceptInvite(
        db,
        { ...guest, id: 'stranger', email: 'stranger@example.test' },
        blocked.token,
      ),
    ).toBeNull();
  } finally {
    sqlite.close();
  }
});

it('stores API verifiers only, isolates project/environment scopes and observes revocation/expiry on every request', async () => {
  const { db, sqlite } = fixture();
  try {
    const minted = await createApiToken(db, owner, {
      name: 'Agent',
      permission: 'manage',
      scopes: [{ app_id: 'app', environment_id: 'env' }],
    });
    const identity = (await apiTokenIdentity(db, minted.token))!;
    expect(identity).toMatchObject({
      authKind: 'api-token',
      workspaceId: 'ws',
      apiPermission: 'manage',
      appIds: ['app'],
    });
    expect(
      JSON.stringify(sqlite.prepare('SELECT * FROM workspace_api_tokens').all()),
    ).not.toContain(minted.token);
    const allowed = (path: string, method = 'GET') =>
      ownerRouteAllowed(new Request('https://health.test' + path, { method }), identity);
    expect(allowed('/v1/analytics/report?app_id=app&environment_id=env')).toBe(true);
    expect(allowed('/v1/analytics/report?app_id=app&environment_id=other-env')).toBe(false);
    expect(allowed('/v1/analytics/definitions?app_id=app&environment_id=env', 'POST')).toBe(true);
    for (const path of [
      '/v1/analytics',
      '/v1/analytics/live',
      '/v1/public-keys',
      '/v1/native-keys',
      '/v1/workspace/members',
      '/v1/workspace/api-tokens',
      '/v1/analytics/shares',
      '/v1/logs',
    ])
      expect(allowed(path)).toBe(false);
    expect(allowed('/v1/workspace/api-tokens', 'POST')).toBe(false);
    const readOnly = { ...identity, apiPermission: 'read' as const };
    expect(
      ownerRouteAllowed(
        new Request('https://health.test/v1/analytics/definitions?app_id=app&environment_id=env', {
          method: 'POST',
        }),
        readOnly,
      ),
    ).toBe(false);
    expect(integrationSkill(identity, 'https://health.test')).not.toContain(minted.token);
    await expect(
      createApiToken(db, owner, {
        name: 'Foreign',
        permission: 'read',
        scopes: [{ app_id: 'other-app', environment_id: 'other-env' }],
      }),
    ).rejects.toThrow('forbidden');
    sqlite.exec(`UPDATE workspace_api_tokens SET expires_at=1 WHERE id='${minted.id}'`);
    expect(await apiTokenIdentity(db, minted.token)).toBeNull();
    sqlite.exec(
      `UPDATE workspace_api_tokens SET expires_at=9999999999999, revoked_at=1 WHERE id='${minted.id}'`,
    );
    expect(await apiTokenIdentity(db, minted.token)).toBeNull();
  } finally {
    sqlite.close();
  }
});

it('protects owners and denies viewer/member and API-token administration at the actual route boundary', async () => {
  const { db, sqlite } = fixture();
  try {
    const call = (path: string, method: string, identity = owner, body?: unknown) =>
      handleWorkspaceAccess(
        new Request('https://health.test' + path, {
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        db,
        identity,
      );
    expect((await call('/v1/workspace/members/user', 'DELETE'))!.status).toBe(403);
    expect(
      (await call('/v1/workspace/members/user', 'PUT', owner, { role: 'viewer' }))!.status,
    ).toBe(403);
    expect(
      (await call('/v1/workspace/members', 'GET', { ...owner, workspaceRole: 'viewer' }))!.status,
    ).toBe(403);
    expect(
      (await call('/v1/workspace/api-tokens', 'POST', { ...owner, authKind: 'api-token' }, {}))!
        .status,
    ).toBe(403);
    expect(
      ownerRouteAllowed(new Request('https://health.test/v1/public-keys'), {
        ...owner,
        workspaceRole: 'viewer',
      }),
    ).toBe(false);
    expect(
      ownerRouteAllowed(new Request('https://health.test/v1/apps', { method: 'POST' }), {
        ...owner,
        workspaceRole: 'viewer',
      }),
    ).toBe(false);
    expect(await selectedMembership(db, 'user', 'ws')).toMatchObject({ role: 'owner' });
  } finally {
    sqlite.close();
  }
});

it('speaks stateless Streamable HTTP with bounded protocol errors and dispatches only authorized tools', async () => {
  const identity: OwnerIdentity = {
    ...owner,
    authKind: 'api-token',
    apiPermission: 'read',
    apiScopes: [{ app_id: 'app', environment_id: 'env' }],
  };
  const calls: Request[] = [];
  const dispatch = async (request: Request, auth: OwnerIdentity) => {
    calls.push(request);
    return Response.json(
      ownerRouteAllowed(request, auth) ? { events: 2 } : { error: 'forbidden' },
      { status: ownerRouteAllowed(request, auth) ? 200 : 403 },
    );
  };
  const call = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
    handleAnalyticsMcp(
      new Request('https://health.test/mcp', {
        method,
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...headers,
        },
        ...(method === 'POST'
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      }),
      identity,
      dispatch,
    );
  const initialized = await call({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  expect(await initialized.json()).toMatchObject({
    id: 0,
    result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
  });
  expect(initialized.headers.has('mcp-session-id')).toBe(false);
  expect((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  expect((await call({}, {}, 'GET')).status).toBe(405);
  expect((await call({}, { origin: 'https://evil.test' })).status).toBe(403);
  expect((await call({}, { 'mcp-protocol-version': 'unknown' })).status).toBe(400);
  expect((await call({}, { accept: 'application/json' })).status).toBe(406);
  expect(await (await call('{')).json()).toMatchObject({ error: { code: -32700 } });
  const listed = (await (await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
    result: { tools: { name: string }[] };
  };
  expect(listed.result.tools.map((tool) => tool.name)).not.toContain('save_definition');
  expect(
    await (
      await call({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'conversion_report', arguments: { app_id: 'app', environment_id: 'env' } },
      })
    ).json(),
  ).toMatchObject({ result: { isError: false } });
  expect(
    await (
      await call({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'conversion_report',
          arguments: { app_id: 'app', environment_id: 'foreign' },
        },
      })
    ).json(),
  ).toMatchObject({ result: { isError: true } });
  expect(calls).toHaveLength(2);
  expect(
    await (
      await call({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'save_definition', arguments: {} },
      })
    ).json(),
  ).toMatchObject({ error: { code: -32602 } });
});
