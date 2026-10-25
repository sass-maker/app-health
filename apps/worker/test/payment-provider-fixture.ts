import type {
  PaymentConnectionInput,
  PaymentProvider,
  PaymentCredentials,
} from '@app-health/contracts';
import { analysisDatabase } from './analysis-sqlite.js';
import { createProviderConnection } from '../src/payment-provider-connections.js';
import { connectionRow } from '../src/payment-provider-store.js';
import { providerSession } from '../src/payment-provider-api.js';

export const MASTER = JSON.stringify({
  v: 1,
  active: 'test-key',
  keys: [{ id: 'test-key', key: btoa('a'.repeat(32)) }],
});
export function providerFixture(provider: PaymentProvider = 'stripe') {
  const database = analysisDatabase();
  database.sqlite.prepare('INSERT INTO workspace_apps VALUES (?,?)').run('other-app', 'ws');
  const account = provider === 'polar' ? 'org_test' : 'acct_test';
  const selector =
    provider === 'polar' ? 'org_test' : provider === 'dodo' ? 'brand_test' : undefined;
  const credentials: PaymentCredentials = {
    api_key: provider === 'stripe' ? 'sk_test_synthetic_for_tests' : 'synthetic_provider_key',
    webhook_secrets: ['whsec_synthetic_endpoint'],
    signature_scheme: 'standard' as const,
  };
  const time = Math.floor((Date.now() - 3600000) / 1000) * 1000;
  const payment: Record<string, unknown> =
    provider === 'stripe'
      ? {
          id: 'ch_1',
          paid: true,
          captured: true,
          status: 'succeeded',
          amount_captured: 1000,
          currency: 'usd',
          created: time / 1000,
          livemode: false,
          payment_intent: 'pi_1',
        }
      : provider === 'polar'
        ? {
            id: 'ord_1',
            paid: true,
            status: 'paid',
            total_amount: 1000,
            currency: 'usd',
            created_at: new Date(time).toISOString(),
            product_id: 'prod_1',
            product: { organization_id: account },
          }
        : {
            payment_id: 'pay_1',
            status: 'succeeded',
            total_amount: 1000,
            currency: 'USD',
            created_at: new Date(time).toISOString(),
            business_id: account,
            brand_id: selector,
            product_cart: [{ product_id: 'prod_1', quantity: 1 }],
          };
  payment.metadata = {
    app_health_source: 'Newsletter',
    app_health_page: '/pricing',
    app_health_campaign: 'Launch',
    email: 'private@example.test',
    name: 'Private Person',
  };
  const refund: Record<string, unknown> =
    provider === 'stripe'
      ? {
          id: 're_1',
          charge: 'ch_1',
          amount: 200,
          currency: 'usd',
          created: time / 1000 + 1,
          status: 'succeeded',
          reason: null,
        }
      : provider === 'polar'
        ? {
            id: 'ref_1',
            order_id: 'ord_1',
            amount: 180,
            tax_amount: 20,
            currency: 'usd',
            created_at: new Date(time + 1000).toISOString(),
            status: 'succeeded',
            organization_id: account,
          }
        : {
            refund_id: 'ref_1',
            payment_id: 'pay_1',
            amount: 200,
            currency: 'USD',
            created_at: new Date(time + 1000).toISOString(),
            status: 'succeeded',
            business_id: account,
            brand_id: selector,
          };
  const payments = [payment],
    refunds = [refund];
  const calls: URL[] = [];
  const controls = {
    products: ['prod_1'],
    failure: 0,
    before: undefined as undefined | ((url: URL) => void),
  };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    controls.before?.(url);
    if (controls.failure)
      return new Response('sensitive provider response', {
        status: controls.failure,
        headers: { 'retry-after': '1' },
      });
    if (url.pathname.endsWith('/account')) return Response.json({ id: account });
    if (url.pathname.includes('/organizations/')) return Response.json({ id: account });
    if (url.pathname.includes('/brands/'))
      return Response.json({ brand_id: selector, business_id: account });
    if (url.pathname.endsWith('/checkout/sessions'))
      return Response.json({ data: [{ id: 'cs_1' }], has_more: false });
    if (url.pathname.includes('/line_items'))
      return Response.json({
        data: controls.products.map((product) => ({ price: { product } })),
        has_more: false,
      });
    const clean = url.pathname.replace(/\/$/, '');
    const parts = clean.split('/');
    const resource = parts.at(-2),
      id = parts.at(-1);
    const isDetail = ['charges', 'payments', 'orders', 'refunds'].includes(resource ?? '');
    const rows = [...(clean.endsWith('/refunds') ? refunds : payments)];
    if (url.searchParams.get('sorting') === '-created_at')
      rows.sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at)));
    if (provider === 'polar' && clean.endsWith('/refunds') && url.searchParams.has('id'))
      return Response.json({
        items: refunds.filter((row) => row.id === url.searchParams.get('id')),
      });
    if (isDetail) {
      const row = (resource === 'refunds' ? refunds : payments).find(
        (value) => (value.id ?? value[resource === 'refunds' ? 'refund_id' : 'payment_id']) === id,
      );
      return row ? Response.json(row) : new Response(null, { status: 404 });
    }
    const page =
      Number(
        url.searchParams.get('page_number') ??
          url.searchParams.get('page') ??
          (provider === 'polar' ? '1' : '0'),
      ) - (provider === 'polar' ? 1 : 0);
    const after = url.searchParams.get('starting_after');
    const start = after ? rows.findIndex((row) => row.id === after) + 1 : page * 25;
    const data = rows.slice(start, start + 25);
    return Response.json(
      provider === 'stripe'
        ? { data, has_more: start + 25 < rows.length }
        : { items: data, pagination: { max_page: Math.ceil(rows.length / 25) } },
    );
  };
  const input: PaymentConnectionInput = {
    app_id: 'app',
    environment_id: 'env',
    provider,
    mode: 'test',
    selector,
    credentials,
    fixture: false,
  };
  const queue = { send: async () => {} };
  const runtime = { db: database.db, keyring: MASTER, fetcher, queue };
  async function connect() {
    const created = await createProviderConnection(runtime, 'ws', input);
    return connectionRow(database.db, created.id);
  }
  async function session() {
    return providerSession(await connect(), credentials, fetcher);
  }
  return {
    ...database,
    account,
    selector,
    credentials,
    time,
    payment,
    refund,
    payments,
    refunds,
    calls,
    controls,
    input,
    runtime,
    connect,
    session,
  };
}
