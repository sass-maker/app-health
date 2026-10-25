import { useSyncExternalStore, type ReactNode } from 'react';

const STORAGE = 'app-health-selected-workspace';
type Scope = { id: string; role: 'owner' | 'editor' | 'viewer' | 'unknown'; epoch: number };
function storedWorkspace() {
  try {
    return sessionStorage.getItem(STORAGE) ?? '';
  } catch {
    return '';
  }
}
let scope: Scope = { id: storedWorkspace(), role: 'unknown', epoch: 0 };
const listeners = new Set<() => void>();
const requests = new Set<AbortController>();
export const workspaceScope = () => scope;
function subscribeWorkspace(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function selectWorkspace(id: string) {
  for (const request of requests) request.abort();
  requests.clear();
  scope = { id, role: 'unknown', epoch: scope.epoch + 1 };
  try {
    if (id) sessionStorage.setItem(STORAGE, id);
    else sessionStorage.removeItem(STORAGE);
  } catch {
    /* Selection also works without storage. */
  }
  const url = new URL(location.href);
  url.search = '';
  url.hash = '#settings';
  history.replaceState(null, '', url);
  for (const listener of listeners) listener();
}
export function updateWorkspaceRole(role: string | null, epoch: number) {
  if (
    epoch !== scope.epoch ||
    !['owner', 'editor', 'viewer'].includes(role ?? '') ||
    scope.role === role
  )
    return;
  scope = { ...scope, role: role as Scope['role'] };
  for (const listener of listeners) listener();
}
export function useWorkspaceScope() {
  return useSyncExternalStore(subscribeWorkspace, workspaceScope);
}
export function scopedRequest(controller: AbortController) {
  requests.add(controller);
  return () => requests.delete(controller);
}

export function workspaceCanManage(role: string) {
  return role === 'owner' || role === 'editor';
}

export function WorkspaceManage({ children }: { children: ReactNode }) {
  return workspaceCanManage(useWorkspaceScope().role) ? children : null;
}
