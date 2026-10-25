import {
  PaymentConnectionInput,
  PaymentImportJob,
  PaymentImportInput,
  PaymentRoutingInput,
  ProviderRevenueReportV1,
  RevenueQueryV1,
  type PaymentConnection,
  type PaymentScopeV1,
} from '@app-health/contracts';
import { LocalPaymentLedger } from './payments-local.js';
import { PROVIDER_COVERAGE, ProviderError } from './payment-provider-model.js';
import { readPublicJson } from './public-body.js';

// Explicit credential-free fixtures only; no real provider credentials or network I/O.
const connections = new Map<string, PaymentConnection>();
const jobs = new Map<string, PaymentImportJob>();
const ledger = new LocalPaymentLedger();
const assignments = new Map<string, PaymentScopeV1>();
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
async function fixtureJob(
  c: PaymentConnection,
  kind: 'import' | 'reconcile' | 'webhook',
  existing: PaymentImportJob,
) {
  const now = Date.now();
  const id = existing.id;
  const product = c.rules.find((rule) => rule.product_id === 'fixture-product');
  const target = assignments.get(c.id) ?? (c.routing === 'exclusive' ? c : product);
  if (target)
    assignments.set(c.id, { app_id: target.app_id, environment_id: target.environment_id });
  let recorded = 0;
  if (target) {
    const base = {
      schema_version: 1 as const,
      app_id: target.app_id,
      environment_id: target.environment_id,
      namespace: { provider: c.provider, account_id: c.account_id, mode: c.mode },
      delivery_id: `fixture-${c.id}`,
    };
    recorded += Number(
      await ledger.record({
        ...base,
        fact: {
          kind: 'payment',
          transaction_id: `fixture-${c.id}`,
          occurred_at: c.created_at,
          amount_minor: 1200,
          currency: 'USD',
          attribution: {},
        },
      }),
    );
    recorded += Number(
      await ledger.record({
        ...base,
        delivery_id: `refund-${c.id}`,
        fact: {
          kind: 'refund',
          transaction_id: `fixture-${c.id}`,
          refund_id: `refund-${c.id}`,
          occurred_at: c.created_at + 1,
          amount_minor: 200,
          currency: 'USD',
        },
      }),
    );
  }
  const job = PaymentImportJob.parse({
    id,
    connection_id: c.id,
    kind,
    status: target ? 'finished' : 'paused',
    phase: target ? 'done' : 'payments',
    from: existing.from,
    to: existing.to,
    processed: 2,
    recorded,
    unresolved: target ? 0 : 1,
    filtered: 0,
    reason: target ? null : 'unmapped_product_cart',
    retry_at: 0,
    created_at: existing.created_at,
    updated_at: now,
    coverage_note:
      'Fixed local fixture: one USD 12 payment and USD 2 refund. No provider connection or live webhook is claimed.',
  });
  jobs.set(id, job);
  if (kind === 'webhook') c.webhook_at = now;
  return json(job, 202);
}
async function createFixture(request: Request, scope: PaymentScopeV1) {
  const input = PaymentConnectionInput.safeParse(await readPublicJson(request, 32768));
  if (!input.success || !input.data.fixture || input.data.credentials || input.data.mode !== 'test')
    throw new ProviderError('local_requires_test_fixture_without_credentials');
  if (input.data.app_id !== scope.app_id || input.data.environment_id !== scope.environment_id)
    throw new ProviderError('fixture_scope_mismatch', 403);
  if (connections.size >= 50) throw new ProviderError('fixture_capacity', 413);
  const existing = [...connections.values()].find(
    (c) =>
      c.provider === input.data.provider &&
      c.app_id === scope.app_id &&
      c.environment_id === scope.environment_id,
  );
  if (existing) throw new ProviderError('fixture_already_connected', 409);
  const id = crypto.randomUUID();
  const c: PaymentConnection = {
    ...scope,
    id,
    provider: input.data.provider,
    account_id: `fixture-${input.data.provider}-${scope.environment_id}`,
    mode: 'test',
    selector: null,
    generation: 1,
    status: 'active',
    routing: 'exclusive',
    rules: [],
    created_at: Date.now() - 1000,
    verified_at: Date.now(),
    webhook_at: null,
    webhook_path: `/v1/payment-webhooks/${input.data.provider}/${id}`,
    fixture: true,
  };
  connections.set(id, c);
  return json(c, 201);
}
async function fixtureAction(request: Request, c: PaymentConnection, action: string | undefined) {
  if (request.method === 'DELETE' && !action) {
    c.status = 'disconnected';
    c.generation++;
    stopFixtureJobs(c.id);
    return json({ disconnected: true, retained_financial_facts: true });
  }
  if (request.method === 'GET' && action === 'jobs')
    return json({ jobs: [...jobs.values()].filter((j) => j.connection_id === c.id) });
  if (request.method === 'GET' && !action) return json(c);
  const configured = await fixtureConfiguration(request, c, action);
  if (configured) return configured;
  const kinds = {
    imports: 'import',
    reconcile: 'reconcile',
    'fixture-webhook': 'webhook',
  } as const;
  if (request.method === 'POST' && action && action in kinds) {
    if (action !== 'fixture-webhook') PaymentImportInput.parse(await readPublicJson(request, 1024));
    return queueFixtureJob(c, kinds[action as keyof typeof kinds]);
  }
  throw new ProviderError('method_not_allowed', 405);
}
export async function localProviderRequest(request: Request, url: URL, scope: PaymentScopeV1) {
  if (url.pathname === '/v1/analytics/provider-revenue') {
    const query = RevenueQueryV1.parse(Object.fromEntries(url.searchParams));
    const report = await ledger.report(query, true);
    return json(
      ProviderRevenueReportV1.parse({
        ...report,
        basis: 'provider_object_created',
        unresolved: [],
        coverage_note: 'LOCAL FIXTURE ONLY. ' + PROVIDER_COVERAGE,
      }),
    );
  }
  if (url.pathname === '/v1/payment-connections') {
    if (request.method === 'POST') return createFixture(request, scope);
    if (request.method !== 'GET') throw new ProviderError('method_not_allowed', 405);
    return json({
      fixture_mode: true,
      connections: [...connections.values()].filter(
        (c) => c.app_id === scope.app_id && c.environment_id === scope.environment_id,
      ),
    });
  }
  const jobMatch = /^\/v1\/payment-imports\/([a-f0-9-]{36})(?:\/(resume|cancel))?$/.exec(
    url.pathname,
  );
  const id = jobMatch ? jobs.get(jobMatch[1])?.connection_id : url.pathname.split('/')[3];
  const c = id ? connections.get(id) : undefined;
  if (!c || c.app_id !== scope.app_id || c.environment_id !== scope.environment_id)
    throw new ProviderError('fixture_not_found', 404);
  if (jobMatch) return fixtureJobAction(request, c, jobs.get(jobMatch[1])!, jobMatch[2]);
  return fixtureAction(request, c, url.pathname.split('/')[4]);
}

async function fixtureConfiguration(
  request: Request,
  c: PaymentConnection,
  action: string | undefined,
) {
  if (request.method === 'POST' && action === 'credentials') {
    const input = await readPublicJson(request, 1024);
    if (JSON.stringify(input) !== '{"fixture":true}')
      throw new ProviderError('fixture_credentials_forbidden');
    c.generation++;
    stopFixtureJobs(c.id);
    c.status = 'active';
    c.verified_at = Date.now();
    return json(c);
  }
  if (c.status !== 'active') throw new ProviderError('fixture_disconnected', 409);
  if (request.method === 'POST' && action === 'verify') {
    c.verified_at = Date.now();
    return json({ verified: true, fixture: true, webhook_received: c.webhook_at !== null });
  }
  if (request.method === 'PUT' && action === 'routing') {
    const input = PaymentRoutingInput.safeParse(await readPublicJson(request, 32768));
    if (!input.success) throw new ProviderError('invalid_provider_routing');
    if (
      input.data.rules.some((r) => r.app_id !== c.app_id || r.environment_id !== c.environment_id)
    )
      throw new ProviderError('fixture_routing_scope_forbidden', 403);
    c.routing = input.data.routing;
    c.rules = input.data.rules;
    return json(c);
  }
  return null;
}

function queueFixtureJob(c: PaymentConnection, kind: PaymentImportJob['kind']) {
  if (jobs.size >= 1000) throw new ProviderError('fixture_job_capacity', 413);
  const now = Date.now(),
    job = PaymentImportJob.parse({
      id: crypto.randomUUID(),
      connection_id: c.id,
      kind,
      status: 'queued',
      phase: 'payments',
      from: 0,
      to: now,
      processed: 0,
      recorded: 0,
      unresolved: 0,
      filtered: 0,
      reason: null,
      retry_at: 0,
      created_at: now,
      updated_at: now,
      coverage_note:
        'LOCAL FIXTURE ONLY: polling runs one fixed USD 12 payment and USD 2 refund; cancel before polling to stop it.',
    });
  jobs.set(job.id, job);
  if (kind === 'webhook') c.webhook_at = now;
  return json(job, 202);
}
async function fixtureJobAction(
  request: Request,
  c: PaymentConnection,
  job: PaymentImportJob,
  action: string | undefined,
) {
  if (action === 'cancel' && request.method === 'POST') {
    if (job.status !== 'finished') job.status = 'cancelled';
    return json(job);
  }
  if (c.status !== 'active') throw new ProviderError('fixture_disconnected', 409);
  if (action === 'resume' && request.method === 'POST') {
    if (job.status === 'paused') job.status = 'queued';
    return json(job);
  }
  if (action || request.method !== 'GET') throw new ProviderError('method_not_allowed', 405);
  return job.status === 'queued' ? fixtureJob(c, job.kind, job) : json(job);
}

function stopFixtureJobs(connection: string) {
  for (const job of jobs.values())
    if (job.connection_id === connection && job.status !== 'finished') job.status = 'cancelled';
}
