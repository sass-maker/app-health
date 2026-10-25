import {
  currencyMinorUnits,
  PaymentAttributionV1,
  type PaymentProvider,
} from '@app-health/contracts';
import {
  object,
  resourceId,
  ProviderError,
  type ConnectionRow,
  type NormalizedResource,
  type Resource,
} from './payment-provider-model.js';

// Polar units and supported currencies are pinned to the provider implementation:
// github.com/polarsource/polar/blob/bb1bac7333eed44a6759e3f5582714b2d434d482/server/polar/kit/currency.py
const polarCurrencies = new Set(
  `AED ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BIF BMD BND BOB BRL BSD BWP BZD CAD CDF CHF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD FKP GBP GEL GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR ISK JMD JPY KES KGS KHR KMF KRW KYD KZT LAK LKR LRD LSL MAD MDL MGA MKD MNT MOP MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RWF SAR SBD SCR SEK SGD SHP SOS SRD SZL THB TJS TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW`.split(
    ' ',
  ),
);
// Sources: docs.stripe.com/currencies;
// docs.dodopayments.com/api-reference/payments/get-payments-1 (ISO smallest unit).
export function providerMinorAmount(provider: PaymentProvider, raw: unknown, currency: string) {
  if (!Number.isSafeInteger(raw) || Number(raw) < 0 || currencyMinorUnits[currency] === undefined)
    throw new ProviderError('invalid_provider_amount_or_currency');
  let amount = Number(raw);
  if (provider === 'polar' && !polarCurrencies.has(currency))
    throw new ProviderError('polar_currency_unsupported');
  if (provider !== 'dodo' && ['ISK', 'UGX'].includes(currency)) {
    if (amount % 100 !== 0) throw new ProviderError('fractional_provider_special_currency');
    amount /= 100;
  }
  if (provider !== 'dodo' && currency === 'MGA') amount *= 100;
  if (!Number.isSafeInteger(amount) || amount > 1000000000000)
    throw new ProviderError('provider_amount_exceeds_limit');
  return amount;
}
export function providerAttribution(metadata: Resource) {
  const result: Record<string, string> = {};
  for (const field of ['source', 'page', 'country', 'campaign'] as const) {
    const parsed = PaymentAttributionV1.shape[field].safeParse(metadata[`app_health_${field}`]);
    if (parsed.success && parsed.data !== undefined) result[field] = parsed.data;
  }
  return result;
}
function createdTime(value: unknown, stripe: boolean) {
  const time = stripe && typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  if (!Number.isSafeInteger(time) || time < 0 || time > Date.now() + 60000)
    throw new ProviderError('invalid_provider_creation_time');
  return time;
}
function stateReason(c: ConnectionRow, row: Resource, kind: 'payment' | 'refund') {
  if (kind === 'refund') {
    if (c.provider === 'stripe' && row.reason === 'expired_uncaptured_charge')
      return 'uncaptured_authorization_release_not_customer_refund';
    return row.status === 'succeeded' ? null : 'refund_not_succeeded';
  }
  if (c.provider === 'stripe') {
    if (row.paid !== true || row.status !== 'succeeded') return 'charge_not_successful';
    if (row.captured !== true) return 'stripe_nonfinal_multicapture_history_unsupported';
    return row.amount_captured === 0 ? 'stripe_no_captured_purchase' : null;
  }
  if (c.provider === 'polar') return row.paid === true ? null : 'order_not_paid';
  return row.status === 'succeeded' ? null : 'payment_not_succeeded_or_partial_capture_unsupported';
}
function assertAccount(c: ConnectionRow, row: Resource, kind: 'payment' | 'refund') {
  if (c.provider === 'stripe' && kind === 'payment' && row.livemode !== (c.mode === 'live'))
    throw new ProviderError('provider_mode_mismatch', 409);
  if (c.provider === 'polar') {
    const account =
      row.organization_id ??
      object(row.product).organization_id ??
      object(row.customer).organization_id;
    if (account !== c.account_id) throw new ProviderError('provider_account_mismatch', 409);
  }
  if (c.provider === 'dodo' && (row.business_id !== c.account_id || row.brand_id !== c.selector))
    throw new ProviderError('provider_account_or_brand_mismatch', 409);
}
function resourceAmount(c: ConnectionRow, row: Resource, kind: 'payment' | 'refund') {
  if (kind === 'payment') return c.provider === 'stripe' ? row.amount_captured : row.total_amount;
  if (c.provider !== 'polar') return row.amount;
  if (!Number.isSafeInteger(row.amount) || !Number.isSafeInteger(row.tax_amount))
    throw new ProviderError('refund_amount_or_tax_missing');
  return Number(row.amount) + Number(row.tax_amount);
}
function resourceProducts(c: ConnectionRow, row: Resource): string[] | null {
  if (c.provider === 'polar')
    return typeof row.product_id === 'string' ? [resourceId(row.product_id)] : null;
  if (
    c.provider !== 'dodo' ||
    !Array.isArray(row.product_cart) ||
    !row.product_cart.length ||
    row.product_cart.length > 100
  )
    return null;
  return [...new Set(row.product_cart.map((item) => resourceId(object(item).product_id)))];
}
export function normalizeProviderResource(
  c: ConnectionRow,
  row: Resource,
  kind: 'payment' | 'refund',
): NormalizedResource {
  assertAccount(c, row, kind);
  const stripe = c.provider === 'stripe';
  const id = resourceId(
    c.provider === 'dodo' ? row[kind === 'payment' ? 'payment_id' : 'refund_id'] : row.id,
  );
  const original =
    c.provider === 'stripe' ? row.charge : row[c.provider === 'polar' ? 'order_id' : 'payment_id'];
  const result: NormalizedResource = {
    kind,
    id,
    transaction: kind === 'payment' ? id : resourceId(original),
    time: createdTime(stripe ? row.created : row.created_at, stripe),
    amount: 0,
    currency: String(row.currency ?? '').toUpperCase(),
    products: null,
    metadata: object(row.metadata),
    reason: stateReason(c, row, kind),
  };
  try {
    result.amount = providerMinorAmount(c.provider, resourceAmount(c, row, kind), result.currency);
    if (kind === 'refund' && !result.amount) throw new ProviderError('invalid_zero_refund');
    if (kind === 'payment') result.products = resourceProducts(c, row);
  } catch (error) {
    result.reason = error instanceof ProviderError ? error.code : 'provider_resource_invalid';
  }
  return result;
}
