import type { PaymentConnectionInput, PaymentCredentials } from '@app-health/contracts';
import { readPublicJson } from './public-body.js';
import {
  object,
  providerRoot,
  ProviderError,
  resourceId,
  type ProviderSession,
  type Resource,
} from './payment-provider-model.js';

export async function providerGet(
  session: ProviderSession,
  path: string,
  params: Record<string, string> = {},
): Promise<Resource> {
  if (++session.requests > 10) throw new ProviderError('slice_request_budget', 503);
  const remaining = (session.deadline ?? performance.now() + 10000) - performance.now();
  if (remaining < 50) throw new ProviderError('slice_request_budget', 503);
  const url = new URL(
    `${providerRoot(session.connection.provider, session.connection.mode)}${path}`,
  );
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.credentials.api_key}`,
    accept: 'application/json',
  };
  if (session.connection.provider === 'stripe') headers['Stripe-Version'] = '2026-09-30.endive';
  if (session.connection.provider === 'polar') headers['Polar-Version'] = '2026-10';
  let response: Response;
  try {
    response = await session.fetcher(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(5000, remaining)))),
    });
  } catch {
    throw new ProviderError('provider_network_unavailable', 503, Date.now() + 60000);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429)
      throw new ProviderError(
        'provider_rate_limited',
        429,
        retryTime(response.headers.get('retry-after')),
      );
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? 'provider_credentials_or_permissions_rejected'
        : 'provider_resource_unavailable',
      503,
      Date.now() + 60000,
    );
  }
  try {
    return object(await readPublicJson(response, 524288));
  } catch {
    throw new ProviderError('provider_response_invalid_or_too_large', 503);
  }
}
function retryTime(value: string | null) {
  const seconds = Number(value);
  const delay =
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(value ?? '') - Date.now();
  return Date.now() + Math.max(1000, Math.min(Number.isFinite(delay) ? delay : 60000, 3600000));
}
export function providerSession(
  connection: ProviderSession['connection'],
  credentials: PaymentCredentials,
  fetcher: typeof fetch = fetch,
): ProviderSession {
  return { connection, credentials, fetcher, requests: 0 };
}
export async function verifyProviderAccount(
  input: PaymentConnectionInput,
  fetcher: typeof fetch = fetch,
) {
  if (!input.credentials) throw new ProviderError('provider_credentials_required');
  const temporary = {
    ...input,
    id: '',
    account_id: '',
    selector: input.selector ?? null,
    generation: 1,
    workspace_id: '',
    status: 'active' as const,
    routing: 'exclusive' as const,
    cipher: null,
    verified_at: 0,
    created_at: 0,
    webhook_at: null,
  };
  const session = providerSession(temporary, input.credentials, fetcher);
  if (input.provider === 'stripe') return verifyStripeAccount(session);
  if (!input.selector) throw new ProviderError('organization_or_brand_selector_required');
  const path = input.provider === 'polar' ? '/organizations/' : '/brands/';
  const account = await providerGet(session, path + encodeURIComponent(input.selector));
  const selected = input.provider === 'polar' ? account.id : account.brand_id;
  if (selected !== input.selector)
    throw new ProviderError('provider_account_identity_mismatch', 409);
  return resourceId(input.provider === 'polar' ? account.id : account.business_id);
}
async function verifyStripeAccount(session: ProviderSession) {
  const expected = session.connection.mode === 'live' ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
  if (!expected.test(session.credentials.api_key))
    throw new ProviderError('stripe_mode_key_mismatch');
  return resourceId((await providerGet(session, '/account')).id);
}
export async function providerResource(
  session: ProviderSession,
  kind: 'payment' | 'refund',
  id: string,
) {
  resourceId(id);
  if (session.connection.provider === 'polar' && kind === 'refund') {
    const page = await providerGet(session, '/refunds/', {
      id,
      organization_id: session.connection.account_id,
      limit: '1',
    });
    const rows = Array.isArray(page.items) ? page.items : [];
    const row = object(rows[0]);
    if (row.id !== id) throw new ProviderError('provider_refund_not_found', 503);
    return row;
  }
  const paths = {
    stripe: ['/charges/', '/refunds/'],
    polar: ['/orders/', '/refunds/'],
    dodo: ['/payments/', '/refunds/'],
  };
  return providerGet(
    session,
    paths[session.connection.provider][kind === 'payment' ? 0 : 1] + encodeURIComponent(id),
  );
}
