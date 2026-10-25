import { WorkspaceMemberInput } from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';
import { acceptInvite, createApiToken, createInvite, listWorkspaces } from './workspace-access.js';
import { readPublicJson } from './public-body.js';

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function handleWorkspaceAccess(
  request: Request,
  db: D1DatabaseLike,
  owner: OwnerIdentity,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!isWorkspaceRoute(path)) return null;
  if (owner.authKind !== 'account' || !owner.workspaceId)
    return json(403, { error: 'Account sign-in required' });
  try {
    if (path === '/v1/workspaces')
      return request.method === 'GET'
        ? json(200, { workspaces: await listWorkspaces(db, owner.id) })
        : json(405, { error: 'Method not allowed' });
    if (path === '/v1/invites/accept') return acceptInvitation(request, db, owner);
    if (owner.workspaceRole !== 'owner')
      return json(403, { error: 'Workspace owner access required' });
    const [, , , collection, id] = path.split('/');
    if (collection === 'members') return members(request, db, owner, id);
    if (collection === 'invites') return invites(request, db, owner, id);
    if (collection === 'api-tokens') return apiTokens(request, db, owner, id);
    return json(405, { error: 'Method not allowed' });
  } catch {
    return json(400, { error: 'Invalid or unavailable workspace action' });
  }
}

async function members(request: Request, db: D1DatabaseLike, owner: OwnerIdentity, id?: string) {
  if (request.method === 'GET' && !id) {
    const result = await db
      .prepare(
        `SELECT u.id, u.name, u.email, CASE WHEN w.owner_id = u.id THEN 'owner' WHEN m.role = 'owner' THEN 'editor' ELSE m.role END AS role
      FROM workspaces w JOIN "user" u ON u.id = w.owner_id OR EXISTS(SELECT 1 FROM workspace_members x WHERE x.workspace_id = w.id AND x.user_id = u.id)
      LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = u.id WHERE w.id = ? ORDER BY u.name LIMIT 101`,
      )
      .bind(owner.workspaceId)
      .all();
    if (result.results.length > 100) return json(409, { error: 'Member limit exceeded' });
    return json(200, { members: result.results });
  }
  if (!id || !['PUT', 'DELETE'].includes(request.method))
    return json(405, { error: 'Method not allowed' });
  const mutable =
    'workspace_id = ? AND user_id = ? AND user_id != (SELECT owner_id FROM workspaces WHERE id = ?)';
  if (request.method === 'DELETE') {
    const result = await db
      .prepare(`DELETE FROM workspace_members WHERE ${mutable}`)
      .bind(owner.workspaceId, id, owner.workspaceId)
      .run();
    return json(result.meta.changes ? 200 : 403, { removed: !!result.meta.changes });
  }
  const input = WorkspaceMemberInput.parse(await readPublicJson(request, 4096));
  const result = await db
    .prepare(`UPDATE workspace_members SET role = ? WHERE ${mutable}`)
    .bind(input.role, owner.workspaceId, id, owner.workspaceId)
    .run();
  return json(result.meta.changes ? 200 : 403, { updated: !!result.meta.changes });
}

async function invites(request: Request, db: D1DatabaseLike, owner: OwnerIdentity, id?: string) {
  if (request.method === 'GET' && !id)
    return json(200, {
      invites: (
        await db
          .prepare(
            'SELECT id, email, role, created_at, expires_at, revoked_at, accepted_at FROM workspace_invites WHERE workspace_id = ? ORDER BY (revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?) DESC, created_at DESC LIMIT 100',
          )
          .bind(owner.workspaceId, Date.now())
          .all()
      ).results,
    });
  if (request.method === 'POST' && !id) {
    const result = await createInvite(db, owner, await readPublicJson(request, 4096));
    return json(201, {
      ...result,
      url: `${new URL(request.url).origin}/app#invite=${result.token}`,
    });
  }
  if (request.method === 'DELETE' && id)
    return revoke(db, 'workspace_invites', owner.workspaceId!, id);

  return json(405, { error: 'Method not allowed' });
}

async function apiTokens(request: Request, db: D1DatabaseLike, owner: OwnerIdentity, id?: string) {
  if (request.method === 'GET' && !id) {
    const rows = await db
      .prepare(
        'SELECT id, name, permission, scopes_json, created_at, expires_at, revoked_at FROM workspace_api_tokens WHERE workspace_id = ? ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC LIMIT 100',
      )
      .bind(owner.workspaceId, Date.now())
      .all();
    return json(200, {
      tokens: rows.results.map(({ scopes_json, ...row }) => ({
        ...row,
        scopes: JSON.parse(String(scopes_json)),
      })),
    });
  }
  if (request.method === 'POST' && !id)
    return json(201, await createApiToken(db, owner, await readPublicJson(request, 16384)));
  if (request.method === 'DELETE' && id)
    return revoke(db, 'workspace_api_tokens', owner.workspaceId!, id);

  return json(405, { error: 'Method not allowed' });
}

async function acceptInvitation(request: Request, db: D1DatabaseLike, owner: OwnerIdentity) {
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = (await readPublicJson(request, 4096)) as { token?: unknown } | null;
  const workspace =
    typeof body?.token === 'string' ? await acceptInvite(db, owner, body.token) : null;
  return workspace
    ? json(200, { workspace_id: workspace })
    : json(403, { error: 'Invitation unavailable, expired, or for another verified email' });
}

function isWorkspaceRoute(path: string) {
  return (
    ['/v1/workspaces', '/v1/invites/accept'].includes(path) ||
    /^\/v1\/workspace\/(members|invites|api-tokens)(\/[^/]+)?$/.test(path)
  );
}

async function revoke(
  db: D1DatabaseLike,
  table: 'workspace_invites' | 'workspace_api_tokens',
  workspace: string,
  id: string,
) {
  const result = await db
    .prepare(
      `UPDATE ${table} SET revoked_at = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL`,
    )
    .bind(Date.now(), workspace, id)
    .run();
  return json(result.meta.changes ? 200 : 404, { revoked: !!result.meta.changes });
}
