const API_BASE = (import.meta.env.VITE_APP_HEALTH_API as string | undefined) ?? '';

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
  return fetch(typeof path === 'string' ? apiUrl(path) : path, { ...init, headers });
}
