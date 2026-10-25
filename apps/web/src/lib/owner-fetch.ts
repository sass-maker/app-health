const API_BASE = (import.meta.env.VITE_APP_HEALTH_API as string | undefined) ?? '';
import { scopedRequest, updateWorkspaceRole, workspaceScope } from './workspace-scope.js';

export function apiUrl(path: string): URL {
  return new URL(path, API_BASE || window.location.origin);
}

export function ownerFetch(
  path: string | URL,
  ownerToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (ownerToken) headers.set('authorization', `Bearer ${ownerToken}`);
  const captured = workspaceScope();
  const target = typeof path === 'string' ? apiUrl(path) : path;
  if (
    captured.id &&
    !['/v1/workspaces', '/v1/invites/accept', '/v1/account/config'].includes(target.pathname) &&
    !target.pathname.startsWith('/v1/auth/')
  )
    headers.set('x-app-health-workspace', captured.id);
  const controller = new AbortController();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const release = scopedRequest(controller);
  return fetch(typeof path === 'string' && !API_BASE ? path : target, {
    ...init,
    headers: Object.fromEntries(headers),
    signal: controller.signal,
  })
    .then((response) => {
      if (captured.epoch !== workspaceScope().epoch)
        throw new DOMException('Workspace changed', 'AbortError');
      updateWorkspaceRole(
        response.headers?.get('x-app-health-workspace-role') ?? null,
        captured.epoch,
      );
      return response;
    })
    .finally(() => {
      release();
    });
}
