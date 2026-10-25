import type { OwnerIdentity } from './identity.js';

const dataReads = new Set([
  '/v1/apps',
  '/v1/analytics',
  '/v1/analytics/live',
  '/v1/analytics/report',
  '/v1/analytics/conversions',
  '/v1/analytics/revenue',
  '/v1/analytics/definitions',
  '/v1/endpoints',
  '/v1/failures',
  '/v1/installation/status',
  '/v1/workspace/health',
  '/v1/reports/speed',
  '/v1/reports/daily-engagement',
  '/v1/reports/portfolio-briefing',
  '/v1/workspace/alerts',
  '/v1/capabilities',
]);
const tokenReads = new Set([
  '/v1/apps',
  '/v1/analytics/report',
  '/v1/analytics/conversions',
  '/v1/analytics/revenue',
  '/v1/analytics/definitions',
  '/v1/endpoints',
  '/v1/failures',
  '/v1/installation/status',
  '/v1/integration/skill',
]);
const definitionPath = /^\/v1\/analytics\/definitions(?:\/[a-f0-9-]{36})?$/;

export function ownerRouteAllowed(request: Request, owner: OwnerIdentity): boolean {
  const url = new URL(request.url);
  const path = url.pathname;
  if (owner.authKind === 'api-token') return tokenRouteAllowed(request, owner, url);
  if (owner.workspaceRole === 'viewer') return request.method === 'GET' && dataReads.has(path);
  if (owner.workspaceRole === 'editor') return editorRouteAllowed(request, path);

  return true;
}

function tokenRouteAllowed(request: Request, owner: OwnerIdentity, url: URL) {
  const path = url.pathname;
  const selected = request.headers.get('x-app-health-workspace');
  if (selected && selected !== owner.workspaceId) return false;
  const read = request.method === 'GET' && tokenReads.has(path);
  const write =
    owner.apiPermission === 'manage' &&
    definitionPath.test(path) &&
    ['POST', 'PUT', 'DELETE'].includes(request.method);
  if (!read && !write) return false;
  if (path === '/v1/apps' || path === '/v1/integration/skill') return true;
  if (
    url.searchParams.getAll('app_id').length !== 1 ||
    url.searchParams.getAll('environment_id').length !== 1
  )
    return false;
  return !!owner.apiScopes?.some(
    (scope) =>
      scope.app_id === url.searchParams.get('app_id') &&
      scope.environment_id === url.searchParams.get('environment_id'),
  );
}

function editorRouteAllowed(request: Request, path: string) {
  if (request.method === 'GET')
    return (
      dataReads.has(path) ||
      [
        '/v1/logs',
        '/v1/logs/cache-summary',
        '/v1/public-keys',
        '/v1/native-keys',
        '/v1/analytics/shares',
        '/v1/capabilities/ledger',
      ].includes(path)
    );
  return (
    definitionPath.test(path) ||
    (request.method === 'POST' && /^\/v1\/apps\/[^/]+\/environments\/[^/]+\/keys$/.test(path)) ||
    [
      '/v1/apps',
      '/v1/capabilities',
      '/v1/public-keys',
      '/v1/native-keys',
      '/v1/analytics/shares',
    ].includes(path) ||
    /^\/v1\/apps\/[^/]+\/environments(?:\/[^/]+(?:\/revoke)?)?$/.test(path) ||
    /^\/v1\/(public-keys|native-keys)\/[^/]+\/revoke$/.test(path)
  );
}
