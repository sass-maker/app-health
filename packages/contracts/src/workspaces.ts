import { z } from 'zod';

export const WorkspaceRole = z.enum(['owner', 'editor', 'viewer']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;
export const WorkspaceSummary = z.object({ id: z.string(), name: z.string(), role: WorkspaceRole });
export const WorkspaceList = z.object({ workspaces: z.array(WorkspaceSummary).max(100) });
export const WorkspaceInviteInput = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: z.enum(['editor', 'viewer']),
    expires_in_days: z.number().int().min(1).max(7).default(7),
  })
  .strict();
export const WorkspaceMemberInput = z.object({ role: z.enum(['editor', 'viewer']) }).strict();
export const ApiTokenScope = z
  .object({
    app_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    environment_id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  })
  .strict();
export type ApiTokenScope = z.infer<typeof ApiTokenScope>;
export const ApiTokenScopes = z.array(ApiTokenScope).min(1).max(50);
export const ApiTokenInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    permission: z.enum(['read', 'manage']),
    scopes: ApiTokenScopes,
    expires_in_days: z.number().int().min(1).max(365).default(90),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.scopes.map((scope) => JSON.stringify(scope))).size === value.scopes.length,
    'Duplicate scopes',
  );
export type ApiTokenInput = z.infer<typeof ApiTokenInput>;
export const WorkspaceAccess = z.object({
  workspace: WorkspaceSummary,
  user: z.object({ name: z.string() }),
});
