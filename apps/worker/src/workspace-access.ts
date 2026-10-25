import {
  ApiTokenInput,
  ApiTokenScopes,
  WorkspaceInviteInput,
  type WorkspaceRole,
} from '@app-health/contracts';
import { generateRawKey, hashKey } from './crypto.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import type { OwnerIdentity } from './identity.js';

export const WORKSPACE_HEADER = 'x-app-health-workspace';
export type WorkspaceMembership = { id: string; name: string; role: WorkspaceRole };
export async function selectedMembership(db: D1DatabaseLike, user: string, workspace: string) {
  return db
    .prepare(
      `SELECT w.id, w.name, CASE WHEN w.owner_id = ? THEN 'owner' WHEN m.role = 'owner' THEN 'editor' ELSE m.role END AS role
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
    WHERE w.id = ? AND (w.owner_id = ? OR m.user_id IS NOT NULL)`,
    )
    .bind(user, user, workspace, user)
    .first<WorkspaceMembership>();
}

export async function listWorkspaces(db: D1DatabaseLike, user: string) {
  const rows = await db
    .prepare(
      `SELECT w.id, w.name, CASE WHEN w.owner_id = ? THEN 'owner' WHEN m.role = 'owner' THEN 'editor' ELSE m.role END AS role
    FROM workspaces w LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
    WHERE w.owner_id = ? OR m.user_id IS NOT NULL ORDER BY w.created_at, w.id LIMIT 101`,
    )
    .bind(user, user, user)
    .all<WorkspaceMembership>();
  if (rows.results.length > 100) throw new Error('Workspace limit exceeded');
  return rows.results;
}

export async function createInvite(db: D1DatabaseLike, owner: OwnerIdentity, value: unknown) {
  const input = WorkspaceInviteInput.parse(value);
  const raw = generateRawKey('ahi_');
  const id = crypto.randomUUID();
  const now = Date.now();
  const expires = now + input.expires_in_days * 86400000;
  const result = await db
    .prepare(
      `INSERT INTO workspace_invites
    (id, workspace_id, email, role, verifier_hash, created_by, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM workspace_invites WHERE workspace_id = ? AND expires_at > ? AND revoked_at IS NULL AND accepted_at IS NULL) < 100`,
    )
    .bind(
      id,
      owner.workspaceId,
      input.email,
      input.role,
      await hashKey(raw),
      owner.id,
      now,
      expires,
      owner.workspaceId,
      now,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error('Invitation limit reached');
  return { id, token: raw, email: input.email, role: input.role, expires_at: expires };
}

export async function acceptInvite(db: D1DatabaseLike, owner: OwnerIdentity, token: string) {
  if (!/^ahi_[a-f0-9]{64}$/.test(token) || !owner.email) return null;
  const hash = await hashKey(token);
  const now = Date.now();
  const email = owner.email.trim().toLowerCase();
  const eligible = `verifier_hash = ? AND email = ? AND expires_at > ? AND revoked_at IS NULL AND accepted_at IS NULL`;
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_members(workspace_id, user_id, role, created_at)
      SELECT workspace_id, ?, role, ? FROM workspace_invites WHERE ${eligible}
      AND (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = workspace_invites.workspace_id AND user_id != (SELECT owner_id FROM workspaces WHERE id = workspace_invites.workspace_id)) < 99
      AND NOT EXISTS(SELECT 1 FROM workspaces WHERE id = workspace_id AND owner_id = ?)`,
      )
      .bind(owner.id, now, hash, email, now, owner.id),
    db
      .prepare(
        `UPDATE workspace_invites SET accepted_at = ?, accepted_by = ? WHERE ${eligible}
      AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = workspace_invites.workspace_id AND user_id = ?)`,
      )
      .bind(now, owner.id, hash, email, now, owner.id),
    db
      .prepare(
        `SELECT workspace_id FROM workspace_invites WHERE verifier_hash = ? AND email = ? AND accepted_by = ?
      AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id = workspace_invites.workspace_id AND user_id = ?)`,
      )
      .bind(hash, email, owner.id, owner.id),
  ]);
  return (results[2]?.results?.[0]?.workspace_id as string | undefined) ?? null;
}

export async function createApiToken(db: D1DatabaseLike, owner: OwnerIdentity, value: unknown) {
  const input = ApiTokenInput.parse(value);
  for (const scope of input.scopes) {
    const owned = await db
      .prepare(
        `SELECT e.id FROM environments e JOIN workspace_apps wa ON wa.app_id = e.app_id
      JOIN apps a ON a.id = e.app_id AND a.archived_at IS NULL
      WHERE wa.workspace_id = ? AND e.app_id = ? AND e.id = ?`,
      )
      .bind(owner.workspaceId, scope.app_id, scope.environment_id)
      .first();
    if (!owned) throw new Error('Token scope forbidden');
  }
  const raw = generateRawKey('aha_');
  const id = crypto.randomUUID();
  const now = Date.now();
  const expires = now + input.expires_in_days * 86400000;
  const result = await db
    .prepare(
      `INSERT INTO workspace_api_tokens
    (id, workspace_id, name, permission, scopes_json, verifier_hash, created_by, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE
      (SELECT COUNT(*) FROM workspace_api_tokens WHERE workspace_id = ? AND revoked_at IS NULL AND expires_at > ?) < 100`,
    )
    .bind(
      id,
      owner.workspaceId,
      input.name,
      input.permission,
      JSON.stringify(input.scopes),
      await hashKey(raw),
      owner.id,
      now,
      expires,
      owner.workspaceId,
      now,
    )
    .run();
  if (result.meta.changes !== 1) throw new Error('API token limit reached');
  return {
    id,
    token: raw,
    name: input.name,
    permission: input.permission,
    scopes: input.scopes,
    expires_at: expires,
  };
}

export async function apiTokenIdentity(
  db: D1DatabaseLike,
  raw: string,
): Promise<OwnerIdentity | null> {
  if (!/^aha_[a-f0-9]{64}$/.test(raw)) return null;
  const row = await db
    .prepare(
      `SELECT id, workspace_id, name, permission, scopes_json FROM workspace_api_tokens
    WHERE verifier_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(await hashKey(raw), Date.now())
    .first<{
      id: string;
      workspace_id: string;
      name: string;
      permission: 'read' | 'manage';
      scopes_json: string;
    }>();
  if (!row) return null;
  const scopes = ApiTokenScopes.parse(JSON.parse(row.scopes_json));
  const active = [];
  for (const scope of scopes) {
    const owned = await db
      .prepare(
        `SELECT e.id FROM environments e JOIN workspace_apps wa ON wa.app_id = e.app_id
      JOIN apps a ON a.id = e.app_id AND a.archived_at IS NULL
      WHERE wa.workspace_id = ? AND e.app_id = ? AND e.id = ?`,
      )
      .bind(row.workspace_id, scope.app_id, scope.environment_id)
      .first();
    if (owned) active.push(scope);
  }
  if (!active.length) return null;
  return {
    id: row.id,
    label: row.name,
    authKind: 'api-token',
    workspaceRole: 'viewer',
    workspaceId: row.workspace_id,
    appIds: [...new Set(active.map((scope) => scope.app_id))],
    apiPermission: row.permission,
    apiScopes: active,
  };
}
