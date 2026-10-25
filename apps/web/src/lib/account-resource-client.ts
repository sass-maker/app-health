import { createResourceClient } from '@saas-maker/ui/lib/use-resource';
import { workspaceScope } from './workspace-scope.js';

// Keep cached routes within an account. A replaced transport gets its own cache.
// Resource entries expire after the library's five-minute cacheTime; bound the
// account registry too so rotating owner sessions do not retain unbounded keys.
const transports = new WeakMap<
  typeof fetch,
  Map<string, ReturnType<typeof createResourceClient>>
>();
const MAX_CACHED_ACCOUNTS = 8;

export function accountResourceClient(ownerToken: string) {
  ownerToken = JSON.stringify([ownerToken, workspaceScope().id, workspaceScope().epoch]);
  let accounts = transports.get(fetch);
  if (!accounts) {
    accounts = new Map();
    transports.set(fetch, accounts);
  }
  let client = accounts.get(ownerToken);
  if (!client) {
    client = createResourceClient();
    if (accounts.size >= MAX_CACHED_ACCOUNTS) accounts.delete(accounts.keys().next().value!);
  } else accounts.delete(ownerToken);
  accounts.set(ownerToken, client);
  return client;
}
