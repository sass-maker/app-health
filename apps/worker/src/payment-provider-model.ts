import type {
  PaymentConnection,
  PaymentCredentials,
  PaymentImportJob,
  PaymentProvider,
  PaymentRoutingRule,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';

export type ConnectionRow = Omit<PaymentConnection, 'rules' | 'webhook_path' | 'fixture'> & {
  workspace_id: string;
  cipher: string | null;
};
export type JobRow = Omit<PaymentImportJob, 'from' | 'to' | 'coverage_note'> & {
  generation: number;
  from_time: number;
  to_time: number;
  cursor: string;
  resource_kind: 'payment' | 'refund' | null;
  resource_id: string | null;
  delivery_id: string | null;
  body_digest: string | null;
  lease_token: string | null;
  lease_until: number;
  wake_token: string | null;
  wake_until: number;
};
export type ProviderEnvironment = {
  DB?: D1DatabaseLike;
  PAYMENT_ENCRYPTION_KEYRING?: string;
  BROWSER_EVENTS?: ProviderQueue;
  APP_HEALTH_INGEST_HOST?: string;
};
export type ProviderRuntime = {
  db: D1DatabaseLike;
  keyring: string;
  fetcher?: typeof fetch;
  now?: () => number;
  queue?: ProviderQueue;
};
export type ProviderSession = {
  connection: ConnectionRow;
  credentials: PaymentCredentials;
  fetcher: typeof fetch;
  requests: number;
  deadline?: number;
  fence?: { jobId: string; leaseToken: string };
};
export type Resource = Record<string, unknown>;
export type NormalizedResource = {
  kind: 'payment' | 'refund';
  id: string;
  transaction: string;
  time: number;
  amount: number;
  currency: string;
  products: string[] | null;
  metadata: Resource;
  reason: string | null;
};
export const PROVIDER_COVERAGE =
  'Gross paid order/payment values including tax, grouped by immutable provider resource creation date; not capture-date cashflows or accounting revenue. Refunds use refund creation dates. Stripe multicapture timing/history is unsupported; finalized cumulative Charge values only. No fees, FX or allocations inferred. Pagination is observed, not an atomic account snapshot.';
export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly retryAt = 0,
  ) {
    super(code);
  }
}
export function object(value: unknown): Resource {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Resource)
    : {};
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value))
    throw new ProviderError('invalid_provider_identity');
  return value;
}
export function providerRoot(provider: PaymentProvider, mode: 'live' | 'test') {
  if (provider === 'stripe') return 'https://api.stripe.com/v1';
  if (provider === 'polar')
    return mode === 'live' ? 'https://api.polar.sh/v1' : 'https://sandbox-api.polar.sh/v1';
  return mode === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
}
export type RoutingTarget = Pick<PaymentRoutingRule, 'app_id' | 'environment_id'>;

export type ProviderJobWake = {
  type: 'payment-provider-job';
  schema_version: 1 | 2;
  wake_token?: string;
  job_id: string;
  generation: number;
};
type ProviderQueue = {
  send(wake: ProviderJobWake, options?: { delaySeconds: number }): Promise<unknown>;
};

export function providerRuntime(env: ProviderEnvironment): ProviderRuntime {
  if (!env.DB) throw new ProviderError('provider_storage_unavailable', 503);
  return { db: env.DB, keyring: env.PAYMENT_ENCRYPTION_KEYRING ?? '', queue: env.BROWSER_EVENTS };
}

export function requireProviderQueue(runtime: ProviderRuntime) {
  if (!runtime.queue) throw new ProviderError('provider_job_queue_unavailable', 503);
}
