import { useEffect, useMemo, useState } from 'react';
import {
  DEGRADED_ERROR_RATE,
  DEGRADED_P95_MS,
  INSUFFICIENT_DATA_MIN_REQUESTS,
  LOG_LEVELS,
  LOG_SOURCES,
  SEED_APP_ID,
  SEED_APP_NAME,
  SEED_ENV_ID,
  SEED_ENV_NAME,
  UNHEALTHY_ERROR_RATE,
  UNHEALTHY_P95_MS,
  WINDOWS,
  type CreateAppResponseV1,
  type EndpointAggregateV1,
  type EndpointQueryResponseV1,
  type FailureEventV1,
  type FailureQueryResponseV1,
  type InstallationStatusV1,
  type ListAppsResponseV1,
  type CreatePublicLogKeyResponseV1,
  type ListPublicLogKeysResponseV1,
  type LogLevel,
  type LogQueryResponseV1,
  type LogSource,
  type PublicLogKeyV1,
  type StoredLogV1,
  type Runtime,
  type Window,
} from '@app-health/contracts';
import { GitHubIcon } from './GitHubIcon';

const API_BASE = (import.meta.env.VITE_APP_HEALTH_API as string | undefined) ?? '';
const INGEST_ORIGIN =
  (import.meta.env.VITE_APP_HEALTH_INGEST_ORIGIN as string | undefined) ?? window.location.origin;
const STORAGE_KEY = 'app-health-v0-project';

type SortKey = 'health' | 'requests' | 'error_rate' | 'p95' | 'last_seen';
type SortDirection = 'asc' | 'desc';
type DashboardView = 'endpoints' | 'data' | 'logs';

const WINDOW_LABELS: Record<Window, string> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '24h': '24 hours',
};

interface SavedProject {
  appId: string;
  environmentId: string;
  name: string;
  environment: string;
}

const healthWeight: Record<EndpointAggregateV1['health_state'], number> = {
  unhealthy: 4,
  degraded: 3,
  'insufficient-data': 2,
  healthy: 1,
};

function apiUrl(path: string): URL {
  const base = API_BASE || window.location.origin;
  return new URL(path, base);
}

function ownerHeaders(ownerToken: string, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  if (ownerToken) next.set('authorization', `Bearer ${ownerToken}`);
  return next;
}

function ownerFetch(
  path: string | URL,
  ownerToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = typeof path === 'string' ? apiUrl(path) : path;
  return fetch(url, { ...init, headers: ownerHeaders(ownerToken, init.headers) });
}

/** Fetch an owner API URL and parse JSON, throwing on non-2xx so callers share one error path. */
async function loadOwnerJson(url: URL, ownerToken: string): Promise<unknown> {
  const response = await ownerFetch(url, ownerToken);
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json();
}

function readProject(): SavedProject | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedProject>;
    if (!value.appId || !value.environmentId || !value.name || !value.environment) return null;
    return value as SavedProject;
  } catch {
    return null;
  }
}

function availableProjects(listed: ListAppsResponseV1): SavedProject[] {
  return listed.apps.flatMap((entry) =>
    entry.environments.map((environment) => ({
      appId: entry.app.id,
      environmentId: environment.id,
      name: entry.app.name,
      environment: environment.name,
    })),
  );
}

function authorizedProject(
  current: SavedProject | null,
  available: SavedProject[],
): SavedProject | null {
  if (!current) return available[0] ?? null;
  return (
    available.find(
      (candidate) =>
        candidate.appId === current.appId && candidate.environmentId === current.environmentId,
    ) ??
    available[0] ??
    null
  );
}

function sortValue(endpoint: EndpointAggregateV1, key: SortKey): number {
  if (key === 'health') return healthWeight[endpoint.health_state];
  if (key === 'requests') return endpoint.request_count;
  if (key === 'p95') return endpoint.p95_ms;
  if (key === 'error_rate') return endpoint.error_rate;
  return endpoint.last_seen ?? 0;
}

export function sortEndpoints(
  endpoints: EndpointAggregateV1[],
  key: SortKey,
  direction: SortDirection,
): EndpointAggregateV1[] {
  const factor = direction === 'desc' ? -1 : 1;
  return endpoints
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => {
      if (key !== 'last_seen' && a.endpoint.metrics_available !== b.endpoint.metrics_available) {
        return a.endpoint.metrics_available === false ? 1 : -1;
      }
      const av = sortValue(a.endpoint, key);
      const bv = sortValue(b.endpoint, key);
      return av === bv ? a.index - b.index : (av - bv) * factor;
    })
    .map(({ endpoint }) => endpoint);
}

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return 'Never';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function methodClass(method: string): string {
  return `method method-${method.toLowerCase()}`;
}

export function OwnerUnlock({
  onUnlock,
}: {
  onUnlock: (token: string, listed: ListAppsResponseV1) => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await ownerFetch('/v1/apps', token.trim());
      if (response.status === 403) throw new Error('That owner key was not accepted');
      if (!response.ok) throw new Error(`App Health returned ${response.status}`);
      onUnlock(token.trim(), (await response.json()) as ListAppsResponseV1);
      setToken('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unlock App Health');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="unlock-shell">
      <section className="unlock-intro" aria-labelledby="unlock-title">
        <a className="brand" href="/" aria-label="App Health home">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          App Health
        </a>
        <div className="unlock-eyebrow">For developers and service operators</div>
        <h1 id="unlock-title">Private endpoint health from observed traffic.</h1>
        <p>
          App Health turns one fail-open SDK or an existing OpenTelemetry feed into a focused,
          private view of route traffic, latency, errors, and freshness.
        </p>
        <ul aria-label="Privacy guarantees">
          <li>Node, Worker, Go, and OTLP ingestion</li>
          <li>No request bodies, parameters, or identities</li>
          <li>15 minute to 7 day aggregate route windows</li>
        </ul>
        <section className="unlock-proof" aria-label="Current production capabilities">
          <header>
            <span>Current production V0</span>
            <span>Verified release surface</span>
          </header>
          <div className="unlock-proof-row">
            <span className="proof-label">Ingest</span>
            <strong>Node · Worker · Go · OTLP</strong>
            <span className="proof-state proof-state--healthy">Live</span>
          </div>
          <div className="unlock-proof-row">
            <span className="proof-label">Windows</span>
            <strong>15m · 1h · 24h · 7d</strong>
            <span className="proof-state proof-state--healthy">Available</span>
          </div>
          <div className="unlock-proof-row">
            <span className="proof-label">Boundary</span>
            <strong>Aggregate route summaries only</strong>
            <span className="proof-state proof-state--healthy">Enforced</span>
          </div>
          <p>
            The production dashboard and ingest service are live. Verify shipped capabilities in the
            changelog and source.
          </p>
        </section>
        <div className="intro-actions" aria-label="Get started">
          <a
            className="intro-action intro-action--primary"
            href="https://github.com/sass-maker/app-health#install-the-sdks"
          >
            Read install guide <span aria-hidden="true">→</span>
          </a>
          <a className="intro-action intro-action--secondary" href="/changelog">
            Verify current release
          </a>
        </div>
        <nav className="public-links" aria-label="Public product links">
          <a href="https://github.com/sass-maker/app-health/issues">Roadmap</a>
          <a
            href="https://github.com/sass-maker/app-health"
            aria-label="GitHub repository"
            title="GitHub repository"
            target="_blank"
            rel="noopener noreferrer"
          >
            <GitHubIcon />
          </a>
        </nav>
      </section>
      <section className="unlock-panel" aria-label="Unlock App Health">
        <div className="unlock-status">
          <span className="signal-dot" /> For existing private deployments
        </div>
        <h2>Open your dashboard</h2>
        <p>
          Enter the owner key for this Cloudflare deployment. The hosted dashboard has no public
          signup.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Owner key
            <input
              autoComplete="current-password"
              autoFocus
              maxLength={256}
              onChange={(event) => setToken(event.target.value)}
              placeholder="aho_••••••••••••"
              required
              spellCheck={false}
              type="password"
              value={token}
            />
          </label>
          {error ? (
            <div className="inline-error" role="alert">
              {error}. Check the key and try again.
            </div>
          ) : null}
          <button className="primary-button" disabled={submitting || !token.trim()} type="submit">
            {submitting ? 'Checking…' : 'Unlock'}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="unlock-note">The key stays in memory and is cleared when this page closes.</p>
      </section>
    </main>
  );
}

function Setup({
  ownerToken,
  onCreated,
}: {
  ownerToken: string;
  onCreated: (created: CreateAppResponseV1) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await ownerFetch('/v1/apps', ownerToken, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, environment }),
      });
      if (!response.ok) throw new Error(`Setup API returned ${response.status}`);
      onCreated((await response.json()) as CreateAppResponseV1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the app');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="setup-shell">
      <section className="setup-copy" aria-labelledby="setup-title">
        <div className="eyebrow">
          <span className="signal-dot" /> Endpoint observability, distilled
        </div>
        <h1 id="setup-title">Know which routes are healthy before your users tell you.</h1>
        <p className="setup-lede">
          Add one lightweight middleware, or connect an existing OpenTelemetry pipeline. App Health
          turns observed requests into a focused view of traffic, latency, and errors—without
          storing request data.
        </p>
        <div className="trust-list" aria-label="Product guarantees">
          <span>Method + route only</span>
          <span>Fail-open SDKs</span>
          <span>OTLP compatible</span>
          <span>No payload storage</span>
        </div>
      </section>
      <section className="setup-card" aria-label="Create an App Health project">
        <div className="step-label">Step 1 of 2</div>
        <h2>Connect your first service</h2>
        <p>We’ll create a scoped ingest key, then show the exact install snippet.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Application name
            <input
              required
              maxLength={128}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="checkout-api"
              autoFocus
            />
          </label>
          <label>
            Environment
            <input
              required
              maxLength={64}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
            />
          </label>
          {error ? (
            <div className="inline-error" role="alert">
              <strong>Setup failed.</strong> {error}. Check the local API and try again.
            </div>
          ) : null}
          <button className="primary-button" disabled={submitting || !name.trim()} type="submit">
            {submitting ? 'Creating…' : 'Create project'}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <p className="fine-print">
          {import.meta.env.DEV
            ? 'Local V0 · no cloud resources are created'
            : 'Private owner session · the owner key is never stored'}
        </p>
      </section>
    </main>
  );
}

function KeySetup({
  created,
  onDone,
}: {
  created: CreateAppResponseV1;
  onDone: () => void;
}): JSX.Element {
  const [runtime, setRuntime] = useState<'express' | 'hono' | 'pages' | 'echo' | 'otel'>('express');
  const [copied, setCopied] = useState<string | null>(null);
  const key = created.key.key;
  const expressSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { expressMiddleware } from '@saas-maker/app-health/express';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n});\n\napp.use(expressMiddleware({ client: appHealth }));`;
  const honoSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { honoMiddleware } from '@saas-maker/app-health/hono';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n  runtime: 'worker',\n  disableTimer: true,\n});\n\napp.use('*', honoMiddleware({ client: appHealth }));`;
  const pagesSnippet = `npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz\n\nimport { createAppHealthClient } from '@saas-maker/app-health';\nimport { withPagesFunctionHealth } from '@saas-maker/app-health/pages';\n\nconst appHealth = createAppHealthClient({\n  key: '${key}',\n  environment: ${JSON.stringify(created.environment.name)},\n  endpoint: '${INGEST_ORIGIN}/v1/ingest',\n  runtime: 'worker',\n  disableTimer: true,\n});\n\nexport const onRequestGet = withPagesFunctionHealth(\n  { client: appHealth, route: '/users/:id' },\n  async () => Response.json({ ok: true }),\n);`;
  const echoSnippet = `go get github.com/sarthakagrawal927/app-health/packages/go/echo/v5@v5.1.0\n\nimport apphealthechov5 "github.com/sarthakagrawal927/app-health/packages/go/echo/v5"\n\ncleanup := apphealthechov5.Install(e, apphealthechov5.Config{\n  Enabled: true,\n  Environment: ${JSON.stringify(created.environment.name)},\n  Key: ${JSON.stringify(key)},\n  Project: ${JSON.stringify(created.app.name)},\n})\ndefer cleanup()`;
  const otelSnippet = `processors:\n  resource/app_health:\n    attributes:\n      - key: deployment.environment.name\n        value: ${JSON.stringify(created.environment.name)}\n        action: upsert\n\nexporters:\n  otlphttp/app_health:\n    traces_endpoint: '${INGEST_ORIGIN}/v1/traces'\n    headers:\n      Authorization: 'Bearer ${key}'\n\nservice:\n  pipelines:\n    traces:\n      # Keep your current receivers and processors.\n      processors: [your_existing_processors, resource/app_health]\n      exporters: [your_existing_exporter, otlphttp/app_health]`;
  const snippet = {
    express: expressSnippet,
    hono: honoSnippet,
    pages: pagesSnippet,
    echo: echoSnippet,
    otel: otelSnippet,
  }[runtime];

  async function copy(value: string, label: string): Promise<void> {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
  }

  return (
    <main className="install-shell">
      <div className="install-heading">
        <div className="success-mark" aria-hidden="true">
          ✓
        </div>
        <div>
          <div className="eyebrow">Project created</div>
          <h1>Instrument {created.app.name}</h1>
          <p>This key is shown once. Copy it now; App Health stores only its verifier.</p>
        </div>
      </div>
      <section className="key-panel">
        <div>
          <span>Ingest key</span>
          <code>{key}</code>
        </div>
        <button className="secondary-button" onClick={() => void copy(key, 'key')}>
          {copied === 'key' ? 'Copied' : 'Copy key'}
        </button>
      </section>
      <section className="snippet-panel">
        <div className="runtime-tabs" role="tablist" aria-label="Ingestion source">
          <button
            role="tab"
            aria-selected={runtime === 'express'}
            onClick={() => setRuntime('express')}
          >
            Express
          </button>
          <button role="tab" aria-selected={runtime === 'hono'} onClick={() => setRuntime('hono')}>
            Hono Worker
          </button>
          <button
            role="tab"
            aria-selected={runtime === 'pages'}
            onClick={() => setRuntime('pages')}
          >
            Pages Functions
          </button>
          <button role="tab" aria-selected={runtime === 'echo'} onClick={() => setRuntime('echo')}>
            Go + Echo
          </button>
          <button role="tab" aria-selected={runtime === 'otel'} onClick={() => setRuntime('otel')}>
            Existing OpenTelemetry
          </button>
        </div>
        <pre>
          <code>{snippet}</code>
        </pre>
        <button
          className="secondary-button copy-snippet"
          onClick={() => void copy(snippet, 'snippet')}
        >
          {copied === 'snippet' ? 'Copied snippet' : 'Copy snippet'}
        </button>
      </section>
      <div className="install-footer">
        <p>
          {runtime === 'otel'
            ? 'Reload your Collector and send one traced request to a server route.'
            : 'Run your application and make one request to any route.'}
        </p>
        <button className="primary-button" onClick={onDone}>
          I saved the key <span aria-hidden="true">→</span>
        </button>
      </div>
    </main>
  );
}

function connectedTitle(runtime: Runtime | undefined): string {
  if (runtime === 'otel') return 'OpenTelemetry connected';
  if (runtime === 'worker') return 'Cloudflare Worker connected';
  return 'SDK connected';
}

function connectedRuntimeLabel(runtime: Runtime | undefined): string {
  if (runtime === 'node') return 'Node.js';
  if (runtime === 'worker') return 'Cloudflare Worker';
  if (runtime === 'go') return 'Go';
  return 'Your OpenTelemetry pipeline';
}

function connectedMessage(runtime: Runtime | undefined): string {
  return runtime
    ? `${connectedRuntimeLabel(runtime)} is sending endpoint summaries.`
    : 'Endpoint summaries are arriving.';
}

function statusBannerCopy(status: InstallationStatusV1): [string, string] {
  if (status.state === 'waiting')
    return [
      'Waiting for traffic',
      'Start your service and make one request. This page checks automatically.',
    ];
  if (status.state === 'connected')
    return [connectedTitle(status.runtime), connectedMessage(status.runtime)];
  if (status.state === 'stale')
    return [
      'Traffic has gone quiet',
      'This source connected before, but no recent events arrived. Check that your service is running.',
    ];
  if (status.state === 'revoked')
    return [
      'Ingest key revoked',
      'Create a fresh project key before this service can send more endpoint summaries.',
    ];
  return [
    'Installation check unavailable',
    'The metrics API could not verify this installation. Your application remains unaffected.',
  ];
}

function StatusBanner({
  status,
  fixture,
}: {
  status: InstallationStatusV1;
  fixture: boolean;
}): JSX.Element {
  const [title, message] = fixture
    ? [
        'Sample data',
        'These metrics are seeded fixtures, not traffic received from an SDK. Create a project to verify your own service.',
      ]
    : statusBannerCopy(status);
  const bannerClass = 'status-banner status-' + status.state;
  return (
    <section aria-live="polite" className={bannerClass}>
      <span className="status-icon" aria-hidden="true">
        {status.state === 'connected' ? '✓' : status.state === 'waiting' ? '…' : '!'}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      {status.state === 'waiting' ? <span className="checking">Checking every 10s</span> : null}
    </section>
  );
}

function EndpointTableRow({ endpoint }: { endpoint: EndpointAggregateV1 }): JSX.Element {
  const hasMetrics = endpoint.metrics_available !== false;
  return (
    <tr>
      <td>
        <span className={methodClass(endpoint.method)}>{endpoint.method}</span>
      </td>
      <td>
        <div className="route-cell">
          <code className="route">{endpoint.route}</code>
          {endpoint.upstream_sampled ? (
            <span className="sampling-note">OTel sampled estimate</span>
          ) : null}
        </div>
      </td>
      <td>{hasMetrics ? endpoint.request_count.toLocaleString() : '—'}</td>
      <td className={hasMetrics && endpoint.error_rate >= 0.01 ? 'metric-warn' : ''}>
        {hasMetrics ? `${(endpoint.error_rate * 100).toFixed(1)}%` : '—'}
      </td>
      <td>{hasMetrics ? `${endpoint.p50_ms} ms` : '—'}</td>
      <td>{hasMetrics ? `${endpoint.p95_ms} ms` : '—'}</td>
      <td>{formatAge(endpoint.last_seen)}</td>
      <td>
        <span className={`health health-${endpoint.health_state}`}>
          <i />
          {hasMetrics ? endpoint.health_state.replace('-', ' ') : 'metrics sampled'}
        </span>
      </td>
    </tr>
  );
}

function EndpointCard({ endpoint }: { endpoint: EndpointAggregateV1 }): JSX.Element {
  const hasMetrics = endpoint.metrics_available !== false;
  return (
    <article className="endpoint-card">
      <div className="endpoint-card-head">
        <div>
          <span className={methodClass(endpoint.method)}>{endpoint.method}</span>
          <div className="route-cell">
            <code className="route">{endpoint.route}</code>
            {endpoint.upstream_sampled ? (
              <span className="sampling-note">OTel sampled estimate</span>
            ) : null}
          </div>
        </div>
        <span className={`health health-${endpoint.health_state}`}>
          <i />
          {hasMetrics ? endpoint.health_state.replace('-', ' ') : 'metrics sampled'}
        </span>
      </div>
      <dl>
        <div>
          <dt>Requests</dt>
          <dd>{hasMetrics ? endpoint.request_count.toLocaleString() : '—'}</dd>
        </div>
        <div>
          <dt>Error rate</dt>
          <dd>{hasMetrics ? `${(endpoint.error_rate * 100).toFixed(1)}%` : '—'}</dd>
        </div>
        <div>
          <dt>p50</dt>
          <dd>{hasMetrics ? `${endpoint.p50_ms} ms` : '—'}</dd>
        </div>
        <div>
          <dt>p95</dt>
          <dd>{hasMetrics ? `${endpoint.p95_ms} ms` : '—'}</dd>
        </div>
      </dl>
      <p>Last seen {formatAge(endpoint.last_seen)}</p>
    </article>
  );
}

const receivedFields = [
  ['batch_id', 'Retry deduplication', 'Short-lived', 'Eligible for cleanup after 1 hour'],
  ['schema_version', 'Contract validation', 'Not stored', 'Discarded after validation'],
  ['runtime', 'SDK and installation state', 'Latest + aggregate', 'Node, Worker, Go, or OTel'],
  ['release', 'Release comparison', 'Aggregate / failure', 'Failure value expires after 24 hours'],
  ['event_id', 'Failure identity', 'Failures only', 'Queryable for 24 hours'],
  ['timestamp', 'Windowing and freshness', 'Aggregate / inventory / failure', 'No request content'],
  ['method', 'Endpoint identity', 'Inventory + aggregate + failure', 'Uppercase HTTP method'],
  ['route', 'Endpoint identity', 'Inventory + aggregate + failure', 'Normalized template only'],
  [
    'status_code',
    'Counts and error classification',
    'Aggregate / failure',
    'Exact only for 4xx/5xx',
  ],
  ['duration_ms', 'Latency histogram', 'Aggregate / failure', 'Exact only for 4xx/5xx'],
] as const;

const excludedFields = [
  'Request bodies',
  'Response bodies',
  'Headers',
  'Cookies',
  'Query values',
  'Route parameter values',
  'User identity',
  'Logs and stack traces',
];

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(timestamp));
}

function FailureDetail({
  failure,
  detailId,
}: {
  failure: FailureEventV1;
  detailId: string;
}): JSX.Element {
  return (
    <tr className="failure-detail-row">
      <td colSpan={7}>
        <div id={detailId} className="failure-detail-panel">
          <div className="failure-detail-heading">
            <strong>Retained failure detail</strong>
            <span>Exact fields kept for this failed request</span>
          </div>
          <dl className="failure-detail-grid">
            <div>
              <dt>Endpoint</dt>
              <dd>
                <code>
                  {failure.method} {failure.route}
                </code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{failure.status_code}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{failure.duration_ms.toLocaleString()} ms</dd>
            </div>
            <div>
              <dt>Occurred</dt>
              <dd>
                <time dateTime={new Date(failure.occurred_at).toISOString()}>
                  {formatTimestamp(failure.occurred_at)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Release</dt>
              <dd>{failure.release ?? 'Not reported'}</dd>
            </div>
            <div>
              <dt>Failure ID</dt>
              <dd>
                <code>{failure.failure_id}</code>
              </dd>
            </div>
          </dl>
          <p className="failure-detail-boundary">
            No request body, headers, query values, route values, identity, logs, or stack traces
            were collected.
          </p>
        </div>
      </td>
    </tr>
  );
}

function FailureRow({ failure }: { failure: FailureEventV1 }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const detailId = `failure-detail-${failure.failure_id}`;
  const endpointLabel = `${failure.method} ${failure.route} ${failure.status_code}`;

  return (
    <>
      <tr className={expanded ? 'failure-summary-row is-expanded' : 'failure-summary-row'}>
        <td data-label="Method">
          <span className={methodClass(failure.method)}>{failure.method}</span>
        </td>
        <td data-label="Normalized route">
          <code className="route">{failure.route}</code>
        </td>
        <td data-label="Status">
          <span className={`status-code status-code-${Math.floor(failure.status_code / 100)}xx`}>
            {failure.status_code}
          </span>
        </td>
        <td data-label="Duration">{failure.duration_ms.toLocaleString()} ms</td>
        <td data-label="Occurred" title={formatTimestamp(failure.occurred_at)}>
          {formatAge(failure.occurred_at)}
        </td>
        <td data-label="Release">{failure.release ?? '—'}</td>
        <td data-label="Failure ID" className="failure-id-cell">
          <code className="failure-id" title={failure.failure_id}>
            {failure.failure_id}
          </code>
          <button
            type="button"
            className="failure-detail-toggle"
            aria-expanded={expanded}
            aria-controls={detailId}
            aria-label={`${expanded ? 'Hide' : 'View'} details for ${endpointLabel}`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'View details'}
          </button>
        </td>
      </tr>
      {expanded ? <FailureDetail failure={failure} detailId={detailId} /> : null}
    </>
  );
}

function DataReceived({
  project,
  ownerToken,
  windowKey,
}: {
  project: SavedProject;
  ownerToken: string;
  windowKey: Window;
}): JSX.Element {
  const [data, setData] = useState<FailureQueryResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setLoading(true);
      try {
        const url = apiUrl('/v1/failures');
        url.searchParams.set('app_id', project.appId);
        url.searchParams.set('environment_id', project.environmentId);
        url.searchParams.set('window', windowKey);
        url.searchParams.set('limit', '50');
        const next = (await loadOwnerJson(url, ownerToken)) as FailureQueryResponseV1;
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load retained failures');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [ownerToken, project, refresh, windowKey]);

  return (
    <div className="transparency-view">
      <section className="trust-statement" aria-labelledby="trust-statement-title">
        <div className="trust-signal" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <h2 id="trust-statement-title">Every request counts. Only failures leave a row.</h2>
          <p>
            2xx and 3xx requests are folded into counts and fixed latency buckets, then their
            individual events are discarded. 4xx and 5xx details remain queryable for 24 hours.
          </p>
        </div>
        <div className="trust-facts" aria-label="Retention summary">
          <span>
            <strong>10</strong> accepted fields
          </span>
          <span>
            <strong>0</strong> payload fields
          </span>
          <span>
            <strong>24h</strong> max retention
          </span>
        </div>
      </section>

      <section className="data-surface" aria-busy={loading}>
        <div className="surface-heading failure-heading">
          <div>
            <h2>Latest retained failures</h2>
            <span>
              {data?.failures.length ?? 0} of up to 50 shown
              {data ? ` · refreshed ${formatAge(data.refreshed_at)}` : ''}
            </span>
          </div>
          <button
            className="secondary-button compact-button"
            onClick={() => setRefresh((v) => v + 1)}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {error ? (
          <div className="failure-error" role="alert">
            <div>
              <strong>Failure details are unavailable</strong>
              <p>{error}. Collection policy and aggregate metrics are unchanged.</p>
            </div>
            <button className="secondary-button" onClick={() => setRefresh((v) => v + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {loading && !data ? (
          <div className="failure-loading" aria-label="Loading recent failures">
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {!loading && !error && data?.failures.length === 0 ? (
          <div className="failure-empty">
            <strong>No retained failures in the last {WINDOW_LABELS[windowKey]}</strong>
            <p>
              There are no individual 4xx or 5xx rows in this period. Choose a longer period or
              check Endpoints for the complete aggregate traffic picture.
            </p>
          </div>
        ) : null}
        {data && data.failures.length > 0 ? (
          <div className="table-scroll">
            <table className="endpoint-table failure-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Normalized route</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Occurred</th>
                  <th>Release</th>
                  <th>Failure ID</th>
                </tr>
              </thead>
              <tbody>
                {data.failures.map((failure) => (
                  <FailureRow key={failure.failure_id} failure={failure} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="field-ledger" aria-labelledby="field-ledger-title">
        <div className="ledger-intro">
          <h2 id="field-ledger-title">The complete accepted shape</h2>
          <p>
            Unknown fields make the entire batch fail validation. App Health does not silently
            accept extra request data.
          </p>
        </div>
        <div className="table-scroll">
          <table className="ledger-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Why it arrives</th>
                <th>Where it remains</th>
                <th>Boundary</th>
              </tr>
            </thead>
            <tbody>
              {receivedFields.map(([field, purpose, destination, boundary]) => (
                <tr key={field}>
                  <td data-label="Field">
                    <code>{field}</code>
                  </td>
                  <td data-label="Why it arrives">{purpose}</td>
                  <td data-label="Where it remains">{destination}</td>
                  <td data-label="Boundary">{boundary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="excluded-data" aria-labelledby="excluded-data-title">
        <div>
          <h2 id="excluded-data-title">Never collected</h2>
          <p>These fields are absent from the SDK contract and rejected by the ingest validator.</p>
        </div>
        <ul>
          {excludedFields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      </section>

      <p className="transparency-footnote">
        Contract v1 is enforced by the ingest validator.{' '}
        <a
          href="https://github.com/sass-maker/app-health/blob/main/packages/contracts/src/event.ts"
          aria-label="Inspect the source contract"
          title="Inspect the source contract"
          target="_blank"
          rel="noopener noreferrer"
        >
          <GitHubIcon />
        </a>
        . Raw ingest keys are shown once; only a non-reversible verifier is stored. Batch IDs stop
        participating in deduplication after one hour. Failure rows stop being queryable after 24
        hours and are queued for hourly deletion.
      </p>
    </div>
  );
}

const LEVEL_FILTER_LABELS: Record<LogLevel, string> = {
  debug: 'All levels',
  info: 'Info and above',
  warn: 'Warn and above',
  error: 'Errors only',
};

const LEVEL_ICONS: Record<LogLevel, string> = { debug: '🔍', info: '🔔', warn: '⚠️', error: '🚨' };

function formatPropValue(value: StoredLogV1['props'][string]): string {
  return value === null ? 'null' : String(value);
}

function LogRow({ log }: { log: StoredLogV1 }): JSX.Element {
  const props = Object.entries(log.props);
  return (
    <tr>
      <td data-label="Level">
        <span className={`log-level log-level-${log.level}`}>{log.level}</span>
        {log.source === 'browser' ? <span className="log-source">browser</span> : null}
      </td>
      <td data-label="Event">
        <span className="log-icon" aria-hidden="true">
          {log.icon ?? LEVEL_ICONS[log.level]}
        </span>
        <code className="route">{log.event}</code>
      </td>
      <td data-label="Detail" className="log-detail-cell">
        {log.title ? <strong className="log-title">{log.title}</strong> : null}
        {log.description ? <p className="log-description">{log.description}</p> : null}
        {props.length > 0 ? (
          <ul className="log-props" aria-label="Properties">
            {props.map(([key, value]) => (
              <li key={key}>
                <b>{key}</b> {formatPropValue(value)}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td data-label="When" title={formatTimestamp(log.timestamp)}>
        {formatAge(log.timestamp)}
      </td>
    </tr>
  );
}

function LogsSurface({
  data,
  error,
  loading,
  onRefresh,
}: {
  data: LogQueryResponseV1 | null;
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <>
      {error ? (
        <div className="failure-error" role="alert">
          <div>
            <strong>Logs are unavailable</strong>
            <p>{error}. Your application is unaffected; log delivery fails open.</p>
          </div>
          <button className="secondary-button" onClick={onRefresh}>
            Try again
          </button>
        </div>
      ) : null}
      {loading && !data ? (
        <div className="failure-loading" aria-label="Loading logs">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      {!loading && !error && data?.logs.length === 0 ? (
        <div className="failure-empty">
          <strong>No logs match</strong>
          <p>
            Send one from your app with <code>appHealth.log(&apos;signup&apos;, …)</code> or POST a
            batch to <code>/v1/logs</code> with your ingest key. It appears here within seconds.
          </p>
        </div>
      ) : null}
      {data && data.logs.length > 0 ? (
        <div className="table-scroll">
          <table className="endpoint-table log-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>Event</th>
                <th>Detail</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.logs.map((log) => (
                <LogRow key={log.log_id} log={log} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}

/** Owner API URL scoped to the selected app and environment. */
function scopedUrl(path: string, project: SavedProject): URL {
  const url = apiUrl(path);
  url.searchParams.set('app_id', project.appId);
  url.searchParams.set('environment_id', project.environmentId);
  return url;
}

interface LogsFilters {
  level: LogLevel;
  source: LogSource | '';
  event: string;
}

interface LogsResult {
  data: LogQueryResponseV1 | null;
  error: string | null;
  loading: boolean;
}

function LogsView({
  project,
  ownerToken,
}: {
  project: SavedProject;
  ownerToken: string;
}): JSX.Element {
  const [filters, setFilters] = useState<LogsFilters>({ level: 'debug', source: '', event: '' });
  const [result, setResult] = useState<LogsResult>({ data: null, error: null, loading: true });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const url = scopedUrl('/v1/logs', project);
    url.searchParams.set('level', filters.level);
    if (filters.source) url.searchParams.set('source', filters.source);
    if (filters.event) url.searchParams.set('event', filters.event);
    url.searchParams.set('limit', '200');
    setResult((previous) => ({ ...previous, loading: true }));
    loadOwnerJson(url, ownerToken)
      .then((data) => {
        if (!cancelled)
          setResult({ data: data as LogQueryResponseV1, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause.message : 'Could not load logs';
        setResult((previous) => ({ ...previous, error, loading: false }));
      });
    const timer = window.setInterval(() => setRefresh((value) => value + 1), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ownerToken, project, filters, refresh]);

  const { data, error, loading } = result;
  const bump = () => setRefresh((value) => value + 1);
  return (
    <section className="data-surface" aria-busy={loading}>
      <LogsToolbar
        data={data}
        loading={loading}
        filters={filters}
        onFilters={setFilters}
        onRefresh={bump}
      />
      <LogsSurface data={data} error={error} loading={loading} onRefresh={bump} />
      <PublicKeysPanel project={project} ownerToken={ownerToken} />
    </section>
  );
}

function LogsToolbar({
  data,
  loading,
  filters,
  onFilters,
  onRefresh,
}: {
  data: LogQueryResponseV1 | null;
  loading: boolean;
  filters: LogsFilters;
  onFilters: (update: (previous: LogsFilters) => LogsFilters) => void;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="surface-heading failure-heading log-heading">
      <div>
        <h2>Application logs</h2>
        <span>
          {data?.logs.length ?? 0} shown · kept {data?.retention_days ?? 30} days
          {data ? ` · refreshed ${formatAge(data.refreshed_at)}` : ''}
        </span>
      </div>
      <form
        className="log-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const next = String(new FormData(event.currentTarget).get('event') ?? '').trim();
          onFilters((previous) => ({ ...previous, event: next }));
        }}
      >
        <label>
          Level
          <select
            aria-label="Minimum level"
            value={filters.level}
            onChange={(event) =>
              onFilters((previous) => ({ ...previous, level: event.target.value as LogLevel }))
            }
          >
            {LOG_LEVELS.map((value) => (
              <option key={value} value={value}>
                {LEVEL_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source
          <select
            aria-label="Source"
            value={filters.source}
            onChange={(event) =>
              onFilters((previous) => ({
                ...previous,
                source: event.target.value as LogSource | '',
              }))
            }
          >
            <option value="">Server and browser</option>
            {LOG_SOURCES.map((value) => (
              <option key={value} value={value}>
                {value === 'server' ? 'Server only' : 'Browser only'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Event
          <input
            name="event"
            aria-label="Event name"
            placeholder="signup"
            defaultValue={filters.event}
          />
        </label>
        <button type="submit" className="secondary-button compact-button">
          Apply
        </button>
        <button type="button" className="secondary-button compact-button" onClick={onRefresh}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </form>
    </div>
  );
}

interface PublicKeysState {
  keys: PublicLogKeyV1[];
  created: CreatePublicLogKeyResponseV1 | null;
  error: string | null;
}

function parseOrigins(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function PublicKeysPanel({
  project,
  ownerToken,
}: {
  project: SavedProject;
  ownerToken: string;
}): JSX.Element {
  const [state, setState] = useState<PublicKeysState>({ keys: [], created: null, error: null });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const url = apiUrl('/v1/public-keys');
    url.searchParams.set('app_id', project.appId);
    loadOwnerJson(url, ownerToken)
      .then((body) => {
        if (cancelled) return;
        const keys = (body as ListPublicLogKeysResponseV1).keys.filter(
          (key) => key.environment_id === project.environmentId,
        );
        setState((previous) => ({ ...previous, keys, error: null }));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof Error ? cause.message : 'Could not load browser keys';
        setState((previous) => ({ ...previous, error }));
      });
    return () => {
      cancelled = true;
    };
  }, [ownerToken, project, refresh]);

  async function create(origins: string[]): Promise<void> {
    try {
      const response = await ownerFetch('/v1/public-keys', ownerToken, {
        method: 'POST',
        body: JSON.stringify({
          app_id: project.appId,
          environment_id: project.environmentId,
          allowed_origins: origins,
        }),
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const created = (await response.json()) as CreatePublicLogKeyResponseV1;
      setState((previous) => ({ ...previous, created, error: null }));
      setRefresh((value) => value + 1);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : 'Could not create browser key';
      setState((previous) => ({ ...previous, error }));
    }
  }

  async function revoke(keyId: string): Promise<void> {
    const response = await ownerFetch(`/v1/public-keys/${keyId}/revoke`, ownerToken, {
      method: 'POST',
    });
    if (!response.ok) {
      setState((previous) => ({ ...previous, error: `API returned ${response.status}` }));
      return;
    }
    setRefresh((value) => value + 1);
  }

  return (
    <details className="public-keys">
      <summary>
        Browser logging keys ({state.keys.filter((key) => key.revoked_at === null).length} active)
      </summary>
      <p className="public-keys-intro">
        Public keys let pages send logs directly. Each key is pinned to this environment and the
        origins you list, rate limited, and its logs are tagged <code>browser</code>.
      </p>
      <PublicKeyForm onCreate={create} />
      {state.error ? (
        <p className="public-keys-error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.created ? (
        <PublicKeyReveal created={state.created} environment={project.environment} />
      ) : null}
      <PublicKeyList keys={state.keys} onRevoke={revoke} />
    </details>
  );
}

function PublicKeyForm({
  onCreate,
}: {
  onCreate: (origins: string[]) => Promise<void>;
}): JSX.Element {
  return (
    <form
      className="public-key-form"
      onSubmit={(event) => {
        event.preventDefault();
        const origins = parseOrigins(
          String(new FormData(event.currentTarget).get('origins') ?? ''),
        );
        if (origins.length > 0) void onCreate(origins);
      }}
    >
      <label>
        Allowed origins
        <input
          name="origins"
          aria-label="Allowed origins"
          placeholder="https://example.com, http://localhost:5173"
          required
        />
      </label>
      <button type="submit" className="secondary-button compact-button">
        Create browser key
      </button>
    </form>
  );
}

function PublicKeyReveal({
  created,
  environment,
}: {
  created: CreatePublicLogKeyResponseV1;
  environment: string;
}): JSX.Element {
  const snippet = `import { createWebLogger } from '@saas-maker/app-health/web';\n\nconst logs = createWebLogger({\n  publicKey: '${created.key}',\n  environment: ${JSON.stringify(environment)},\n});\n\nlogs.log('pricing.viewed', { props: { plan: 'pro' } });`;
  return (
    <div className="public-key-reveal">
      <strong>Copy this key now; it is shown once.</strong>
      <code className="public-key-value">{created.key}</code>
      <pre>
        <code>{snippet}</code>
      </pre>
    </div>
  );
}

function PublicKeyList({
  keys,
  onRevoke,
}: {
  keys: PublicLogKeyV1[];
  onRevoke: (keyId: string) => Promise<void>;
}): JSX.Element {
  if (keys.length === 0) return <p className="quiet">No browser keys for this environment yet.</p>;
  return (
    <ul className="public-key-list">
      {keys.map((key) => (
        <li key={key.id}>
          <div>
            <code>{key.id}</code>
            <span>{key.allowed_origins.join(', ')}</span>
          </div>
          {key.revoked_at === null ? (
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => void onRevoke(key.id)}
              aria-label={`Revoke browser key ${key.id}`}
            >
              Revoke
            </button>
          ) : (
            <span className="public-key-revoked">revoked {formatAge(key.revoked_at)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

const VIEW_HEADINGS: Record<DashboardView, [string, string, string]> = {
  endpoints: [
    'Observed routes',
    'Endpoint health',
    'Traffic, errors, and latency from requests your service actually handled.',
  ],
  data: [
    'Collection transparency',
    'Data received',
    'The exact telemetry App Health accepts and retains for this environment.',
  ],
  logs: [
    'Application events',
    'Logs',
    'Signups, waitlist joins, failed payments: whatever your app chose to send, by level.',
  ],
};

interface DashboardHandlers {
  onProjectChange: (project: SavedProject) => void;
  onReset: () => void;
  onLock: () => void;
}

function Dashboard({
  project,
  projects,
  ownerToken,
  handlers,
}: {
  project: SavedProject;
  projects: SavedProject[];
  ownerToken: string;
  handlers: DashboardHandlers;
}): JSX.Element {
  const [view, setView] = useState<DashboardView>('endpoints');
  const [windowKey, setWindowKey] = useState<Window>('15m');
  const [sortKey, setSortKey] = useState<SortKey>('health');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [data, setData] = useState<EndpointQueryResponseV1 | null>(null);
  const [status, setStatus] = useState<InstallationStatusV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const endpointsUrl = apiUrl('/v1/endpoints');
        endpointsUrl.searchParams.set('app_id', project.appId);
        endpointsUrl.searchParams.set('environment_id', project.environmentId);
        endpointsUrl.searchParams.set('window', windowKey);
        endpointsUrl.searchParams.set('sort', sortKey);
        endpointsUrl.searchParams.set('sort_dir', sortDirection);
        const statusUrl = apiUrl('/v1/installation/status');
        statusUrl.searchParams.set('app_id', project.appId);
        statusUrl.searchParams.set('environment_id', project.environmentId);
        const [endpointResponse, statusResponse] = await Promise.all([
          ownerFetch(endpointsUrl, ownerToken),
          ownerFetch(statusUrl, ownerToken),
        ]);
        if (!endpointResponse.ok || !statusResponse.ok)
          throw new Error(
            `API returned ${!endpointResponse.ok ? endpointResponse.status : statusResponse.status}`,
          );
        const nextData = (await endpointResponse.json()) as EndpointQueryResponseV1;
        const nextStatus = (await statusResponse.json()) as InstallationStatusV1;
        if (!cancelled) {
          setData(nextData);
          setStatus(nextStatus);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Unknown API error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ownerToken, project, windowKey, sortKey, sortDirection]);

  const sorted = useMemo(
    () => sortEndpoints(data?.endpoints ?? [], sortKey, sortDirection),
    [data, sortKey, sortDirection],
  );

  function changeSort(next: SortKey): void {
    if (next === sortKey) setSortDirection((value) => (value === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(next);
      setSortDirection('desc');
    }
  }

  const environments = projects.filter((candidate) => candidate.appId === project.appId);

  return (
    <div className="product-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="App Health home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          App Health
        </a>
        <div className="project-switcher">
          <span className="project-avatar">{project.name.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{project.name}</strong>
            <select
              aria-label="Environment"
              onChange={(event) => {
                const selected = environments.find(
                  (candidate) => candidate.environmentId === event.target.value,
                );
                if (selected) handlers.onProjectChange(selected);
              }}
              value={project.environmentId}
            >
              {environments.map((candidate) => (
                <option key={candidate.environmentId} value={candidate.environmentId}>
                  {candidate.environment}
                </option>
              ))}
            </select>
          </div>
          <button
            className="project-reset"
            aria-label="Forget local project"
            onClick={handlers.onReset}
          >
            Reset
          </button>
          <button className="lock-button" onClick={handlers.onLock}>
            Lock
          </button>
        </div>
      </header>
      <main className="dashboard">
        <nav className="view-tabs" aria-label="App Health views">
          <button
            aria-current={view === 'endpoints' ? 'page' : undefined}
            onClick={() => setView('endpoints')}
          >
            Endpoints
          </button>
          <button
            aria-current={view === 'data' ? 'page' : undefined}
            onClick={() => setView('data')}
          >
            Data received
          </button>
          <button
            aria-current={view === 'logs' ? 'page' : undefined}
            onClick={() => setView('logs')}
          >
            Logs
          </button>
        </nav>
        <div className="dashboard-heading">
          <div>
            <div className="eyebrow">{VIEW_HEADINGS[view][0]}</div>
            <h1>{VIEW_HEADINGS[view][1]}</h1>
            <p>{VIEW_HEADINGS[view][2]}</p>
          </div>
          {view === 'logs' ? null : (
            <div className="window-control" aria-label="Time window">
              {WINDOWS.map((value) => (
                <button
                  key={value}
                  aria-pressed={windowKey === value}
                  onClick={() => setWindowKey(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
        </div>
        {view === 'endpoints' ? (
          <>
            {error ? (
              <section className="api-error" role="alert">
                <div>
                  <strong>Can’t refresh endpoint data</strong>
                  <p>{error}. Your application is unaffected; the SDK fails open.</p>
                </div>
                <button className="secondary-button" onClick={() => window.location.reload()}>
                  Try again
                </button>
              </section>
            ) : null}
            {status ? (
              <StatusBanner
                status={status}
                fixture={import.meta.env.DEV && project.appId === SEED_APP_ID}
              />
            ) : null}
            <section className="endpoint-surface" aria-busy={loading}>
              <div className="surface-heading">
                <div>
                  <h2>Endpoints</h2>
                  <span>{sorted.length} observed</span>
                </div>
                <label>
                  Sort by
                  <select
                    aria-label="Sort endpoints"
                    value={sortKey}
                    onChange={(event) => changeSort(event.target.value as SortKey)}
                  >
                    <option value="health">Health</option>
                    <option value="requests">Requests</option>
                    <option value="error_rate">Error rate</option>
                    <option value="p95">p95 latency</option>
                    <option value="last_seen">Last seen</option>
                  </select>
                </label>
              </div>
              {loading && !data ? (
                <div className="loading-state">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              {!loading && !error && sorted.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-pulse">
                    <i />
                  </div>
                  <h3>No endpoints observed yet</h3>
                  <p>
                    Start {project.name}, then make a request to any route. It will appear here
                    within a few seconds.
                  </p>
                  <code>curl http://localhost:3000/health</code>
                </div>
              ) : null}
              {sorted.length > 0 ? (
                <>
                  <div className="table-scroll">
                    <table className="endpoint-table">
                      <thead>
                        <tr>
                          <th>Method</th>
                          <th>Route</th>
                          {(
                            [
                              ['requests', 'Requests'],
                              ['error_rate', 'Error rate'],
                              ['p95', 'p50'],
                              ['p95', 'p95'],
                              ['last_seen', 'Last seen'],
                              ['health', 'Health'],
                            ] as [SortKey, string][]
                          ).map(([key, label]) => (
                            <th key={`${key}-${label}`}>
                              <button onClick={() => changeSort(key)}>
                                {label}
                                {sortKey === key ? (
                                  <span
                                    aria-label={
                                      sortDirection === 'desc' ? 'descending' : 'ascending'
                                    }
                                  >
                                    {sortDirection === 'desc' ? '↓' : '↑'}
                                  </span>
                                ) : null}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((endpoint) => (
                          <EndpointTableRow
                            key={`${endpoint.method}|${endpoint.route}`}
                            endpoint={endpoint}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="endpoint-cards">
                    {sorted.map((endpoint) => (
                      <EndpointCard
                        key={`${endpoint.method}|${endpoint.route}`}
                        endpoint={endpoint}
                      />
                    ))}
                  </div>
                </>
              ) : null}
            </section>
            <section className="threshold-note">
              <strong>How health is decided</strong>
              <p>
                <span className="dot healthy" />
                Healthy{' '}
                <b>
                  under {DEGRADED_ERROR_RATE * 100}% errors &amp; {DEGRADED_P95_MS / 1000}s p95
                </b>
                <span className="dot degraded" />
                Degraded{' '}
                <b>
                  ≥{DEGRADED_ERROR_RATE * 100}% errors or {DEGRADED_P95_MS / 1000}s p95
                </b>
                <span className="dot unhealthy" />
                Unhealthy{' '}
                <b>
                  ≥{UNHEALTHY_ERROR_RATE * 100}% errors or {UNHEALTHY_P95_MS / 1000}s p95
                </b>
                <span className="dot low" />
                Low volume <b>under {INSUFFICIENT_DATA_MIN_REQUESTS} requests</b>
              </p>
            </section>
            <footer>
              <span>Updated {data ? formatAge(data.refreshed_at) : '—'}</span>
              <span>
                Percentiles are approximate · only aggregate route metrics are stored · no headers,
                bodies, or identities
              </span>
            </footer>
          </>
        ) : null}
        {view === 'data' ? (
          <DataReceived project={project} ownerToken={ownerToken} windowKey={windowKey} />
        ) : null}
        {view === 'logs' ? <LogsView project={project} ownerToken={ownerToken} /> : null}
      </main>
    </div>
  );
}

export function App(): JSX.Element {
  const [ownerToken, setOwnerToken] = useState<string | null>(() =>
    import.meta.env.DEV ? '' : null,
  );
  const [project, setProject] = useState<SavedProject | null>(() => {
    if (
      import.meta.env.DEV &&
      new URLSearchParams(window.location.search).get('demo') === 'populated'
    )
      return {
        appId: SEED_APP_ID,
        environmentId: SEED_ENV_ID,
        name: SEED_APP_NAME,
        environment: SEED_ENV_NAME,
      };
    return readProject();
  });
  const [created, setCreated] = useState<CreateAppResponseV1 | null>(null);
  const [projects, setProjects] = useState<SavedProject[]>([]);

  useEffect(() => {
    if (ownerToken === null || (import.meta.env.DEV && !project)) return;
    const token = ownerToken;
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const response = await ownerFetch('/v1/apps', token);
        if (!response.ok) return;
        const listed = (await response.json()) as ListAppsResponseV1;
        const available = availableProjects(listed);
        if (cancelled) return;
        setProjects(available);
        const selected = authorizedProject(project, available);
        if (
          selected &&
          (selected.appId !== project?.appId || selected.environmentId !== project.environmentId)
        )
          selectProject(selected);
      } catch {
        // App-list refresh is best effort; dashboard queries report their own failures.
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ownerToken, project?.appId, project?.environmentId]);

  function selectProject(value: SavedProject): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    setProject(value);
    setCreated(null);
  }

  function handleCreated(value: CreateAppResponseV1): void {
    const saved = {
      appId: value.app.id,
      environmentId: value.environment.id,
      name: value.app.name,
      environment: value.environment.name,
    };
    setProjects((available) => [
      ...available.filter((candidate) => candidate.environmentId !== saved.environmentId),
      saved,
    ]);
    selectProject(saved);
    setCreated(value);
  }

  function handleUnlock(token: string, listed: ListAppsResponseV1): void {
    const available = availableProjects(listed);
    const selected = authorizedProject(project, available);
    setProjects(available);
    if (selected) selectProject(selected);
    else reset();
    setOwnerToken(token);
  }

  function reset(): void {
    localStorage.removeItem(STORAGE_KEY);
    setCreated(null);
    setProject(null);
  }

  function lock(): void {
    if (!import.meta.env.DEV) setOwnerToken(null);
    setCreated(null);
  }

  if (ownerToken === null) return <OwnerUnlock onUnlock={handleUnlock} />;
  if (created) return <KeySetup created={created} onDone={() => setCreated(null)} />;
  if (!project) return <Setup ownerToken={ownerToken} onCreated={handleCreated} />;
  return (
    <Dashboard
      project={project}
      projects={
        projects.some((candidate) => candidate.environmentId === project.environmentId)
          ? projects
          : [project, ...projects]
      }
      ownerToken={ownerToken}
      handlers={{ onProjectChange: selectProject, onReset: reset, onLock: lock }}
    />
  );
}
