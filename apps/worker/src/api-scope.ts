import type { OwnerIdentity } from './identity.js';

/** Compare the exact parsed handler scope, independently of query decoding. */
export function apiScopeAllows(
  owner: OwnerIdentity,
  scope: { app_id?: string; environment_id?: string },
) {
  return (
    !owner.apiScopes ||
    owner.apiScopes.some(
      (allowed) =>
        allowed.app_id === scope.app_id && allowed.environment_id === scope.environment_id,
    )
  );
}
