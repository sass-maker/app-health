import { afterEach, expect, it, vi } from 'vitest';
import { withOwnerBuildAttestation } from '../src/build-attestation.js';
import type { OwnerIdentity } from '../src/identity.js';
const owner: OwnerIdentity = {
  id: 'owner',
  label: 'Owner',
  authKind: 'account',
  workspaceRole: 'owner',
  workspaceId: 'workspace',
  appIds: ['app'],
};
afterEach(() => vi.unstubAllGlobals());
it('attests handling source outside the cached report body and ignores requested source', async () => {
  const sha = 'a'.repeat(40);
  vi.stubGlobal('__APP_HEALTH_BUILD_SHA__', sha);
  const response = withOwnerBuildAttestation(
    Response.json(
      { cached: 'unchanged' },
      { headers: { 'server-timing': 'existing;dur=1', 'cache-control': 'no-store' } },
    ),
    new Request('https://health.test/v1/analytics/report', {
      headers: { 'x-requested-sha': 'b'.repeat(40) },
    }),
    owner,
  );
  expect(response.headers.get('x-app-health-build-sha')).toBe(sha);
  expect(response.headers.get('server-timing')).toBe('existing;dur=1');
  expect(await response.json()).toEqual({ cached: 'unchanged' });
});
it.each([undefined, '', 'unknown', 'A'.repeat(40), 'a'.repeat(39)])(
  'omits an absent or invalid build definition %s',
  (sha) => {
    vi.stubGlobal('__APP_HEALTH_BUILD_SHA__', sha);
    expect(
      withOwnerBuildAttestation(
        Response.json({}),
        new Request('https://health.test/v1/analytics'),
        owner,
      ).headers.has('x-app-health-build-sha'),
    ).toBe(false);
  },
);
it.each([
  { ...owner, authKind: 'api-token' as const },
  { ...owner, authKind: undefined },
  { ...owner, workspaceRole: 'viewer' as const },
  { ...owner, workspaceRole: 'editor' as const },
])('does not attest an unauthorized identity %j', (identity) => {
  vi.stubGlobal('__APP_HEALTH_BUILD_SHA__', 'a'.repeat(40));
  expect(
    withOwnerBuildAttestation(
      Response.json({}),
      new Request('https://health.test/v1/analytics/report'),
      identity,
    ).headers.has('x-app-health-build-sha'),
  ).toBe(false);
});
it('keeps public, unrelated and rejected responses outside attestation', () => {
  vi.stubGlobal('__APP_HEALTH_BUILD_SHA__', 'a'.repeat(40));
  for (const [path, status] of [
    ['/', 200],
    ['/v1/apps', 200],
    ['/v1/analytics/report', 403],
  ] as const)
    expect(
      withOwnerBuildAttestation(
        Response.json({}, { status }),
        new Request(`https://health.test${path}`),
        owner,
      ).headers.has('x-app-health-build-sha'),
    ).toBe(false);
});
it('attests only the authorized one-job advance and status diagnostic paths', () => {
  vi.stubGlobal('__APP_HEALTH_BUILD_SHA__', 'a'.repeat(40));
  const path = 'https://health.test/v1/browser/archive-audits/11111111-1111-4111-8111-111111111111';
  for (const request of [new Request(path), new Request(`${path}/advance`, { method: 'POST' })])
    expect(
      withOwnerBuildAttestation(Response.json({ complete: false }), request, owner).headers.get(
        'x-app-health-build-sha',
      ),
    ).toBe('a'.repeat(40));
});
