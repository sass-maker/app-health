import type { OwnerIdentity } from './identity.js';

declare const __APP_HEALTH_BUILD_SHA__: string | undefined;

export function withOwnerBuildAttestation(
  response: Response,
  request: Request,
  owner: OwnerIdentity,
): Response {
  if (owner.authKind !== 'account' || owner.workspaceRole !== 'owner' || response.status >= 400)
    return response;
  const path = new URL(request.url).pathname;
  const report =
    request.method === 'GET' && ['/v1/analytics', '/v1/analytics/report'].includes(path);
  const audit =
    request.method === 'GET'
      ? /^\/v1\/browser\/archive-audits\/[a-f0-9-]{36}$/.test(path)
      : request.method === 'POST' &&
        /^\/v1\/browser\/archive-audits\/[a-f0-9-]{36}\/advance$/.test(path);
  if (!report && !audit) return response;
  const sha = typeof __APP_HEALTH_BUILD_SHA__ === 'string' ? __APP_HEALTH_BUILD_SHA__ : '';
  if (!/^[a-f0-9]{40}$/.test(sha)) return response;
  const headers = new Headers(response.headers);
  headers.set('x-app-health-build-sha', sha);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
