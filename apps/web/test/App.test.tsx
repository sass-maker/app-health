import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PUBLIC_ENTRYPOINTS,
  renderPublicEntrypoint,
} from '../scripts/generate-public-entrypoints.mjs';
import { App, OwnerUnlock, sortEndpoints } from '../src/App.js';
import { SEED_APP_ID } from '@app-health/contracts';
import type {
  AppEnvironmentV1,
  EndpointAggregateV1,
  FailureEventV1,
  InstallationStatusV1,
  PublicLogKeyV1,
  StoredLogV1,
} from '@app-health/contracts';

const STORAGE_KEY = 'app-health-v0-project';
const storageValues = new Map<string, string>();
const storage = {
  getItem: (key: string) => storageValues.get(key) ?? null,
  setItem: (key: string, value: string) => storageValues.set(key, value),
  removeItem: (key: string) => storageValues.delete(key),
  clear: () => storageValues.clear(),
  key: (index: number) => [...storageValues.keys()][index] ?? null,
  get length() {
    return storageValues.size;
  },
};
const savedProject = {
  appId: 'app-test',
  environmentId: 'env-test',
  name: 'checkout-api',
  environment: 'production',
};

const endpoints: EndpointAggregateV1[] = [
  {
    method: 'POST',
    route: '/orders',
    request_count: 260,
    error_count: 18,
    error_rate: 18 / 260,
    p50_ms: 180,
    p95_ms: 2400,
    last_seen: Date.now() - 8_000,
    health_state: 'unhealthy',
  },
  {
    method: 'GET',
    route: '/health',
    request_count: 18,
    error_count: 0,
    error_rate: 0,
    p50_ms: 8,
    p95_ms: 18,
    last_seen: Date.now() - 20_000,
    health_state: 'insufficient-data',
  },
];

const connected: InstallationStatusV1 = {
  state: 'connected',
  runtime: 'node',
  first_seen: Date.now() - 60_000,
  last_seen: Date.now() - 8_000,
  next_action: 'Endpoint summaries are arriving.',
};

function installFetch(options?: {
  status?: InstallationStatusV1;
  endpointRows?: EndpointAggregateV1[];
  failureRows?: FailureEventV1[];
  apps?: AppEnvironmentV1[];
  failureFail?: boolean;
  logRows?: StoredLogV1[];
  logFail?: boolean;
  publicKeys?: PublicLogKeyV1[];
  publicKeyFail?: boolean;
  fail?: boolean;
}) {
  const publicKeys = [...(options?.publicKeys ?? [])];
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    if (options?.fail) throw new Error('connection refused');
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/v1/apps') {
      if (init?.method !== 'POST') return Response.json({ apps: options?.apps ?? [] });
      return new Response(
        JSON.stringify({
          app: { id: 'app-new', name: 'orders-api', created_at: Date.now() },
          environment: {
            id: 'env-new',
            app_id: 'app-new',
            name: 'production',
            created_at: Date.now(),
          },
          key: {
            key: 'ahk_one_time_secret',
            app_id: 'app-new',
            environment_id: 'env-new',
            created_at: Date.now(),
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.pathname === '/v1/installation/status') {
      return Response.json(options?.status ?? connected);
    }
    if (url.pathname === '/v1/endpoints') {
      return Response.json({
        refreshed_at: Date.now(),
        window: url.searchParams.get('window') ?? '15m',
        endpoints: options?.endpointRows ?? endpoints,
      });
    }
    if (url.pathname === '/v1/failures') {
      if (options?.failureFail) return new Response(null, { status: 503 });
      return Response.json({
        refreshed_at: Date.now(),
        window: url.searchParams.get('window') ?? '24h',
        retention_hours: 24,
        limit: Number(url.searchParams.get('limit') ?? 50),
        failures: options?.failureRows ?? [],
      });
    }
    if (url.pathname === '/v1/logs') {
      if (options?.logFail) return new Response(null, { status: 503 });
      const minimum = url.searchParams.get('level') ?? 'debug';
      const order = ['debug', 'info', 'warn', 'error'];
      const eventFilter = url.searchParams.get('event');
      const source = url.searchParams.get('source');
      return Response.json({
        refreshed_at: Date.now(),
        level: minimum,
        retention_days: 30,
        limit: Number(url.searchParams.get('limit') ?? 100),
        logs: (options?.logRows ?? []).filter(
          (row) =>
            order.indexOf(row.level) >= order.indexOf(minimum) &&
            (!eventFilter || row.event === eventFilter) &&
            (!source || row.source === source),
        ),
      });
    }
    if (url.pathname === '/v1/public-keys') {
      if (options?.publicKeyFail) return new Response(null, { status: 503 });
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          allowed_origins: string[];
          environment_id: string;
        };
        const record: PublicLogKeyV1 = {
          id: `pubkey-${publicKeys.length + 1}`,
          app_id: 'app-test',
          environment_id: body.environment_id,
          allowed_origins: body.allowed_origins,
          created_at: Date.now(),
          revoked_at: null,
        };
        publicKeys.push(record);
        return new Response(JSON.stringify({ key: 'ahk_pub_one_time_value', record }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return Response.json({ keys: publicKeys });
    }
    const revoke = url.pathname.match(/^\/v1\/public-keys\/([^/]+)\/revoke$/);
    if (revoke) {
      const key = publicKeys.find((candidate) => candidate.id === revoke[1]);
      if (!key) return new Response(null, { status: 404 });
      key.revoked_at = Date.now();
      return Response.json({ revoked: true, key_id: key.id });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App Health V0 UI', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage);
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the public unlock hero in the initial HTML response', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(html).toContain('data-initial-unlock-shell');
    expect(html).toContain(
      '<h1 id="unlock-title">Private endpoint health from observed traffic.</h1>',
    );
    expect(html).toContain('No request bodies, parameters, or identities');
    expect(html).toContain('Current production V0');
    expect(html).toContain('The production dashboard and ingest service are live.');
    expect(html).toContain('Read install guide');
    expect(html).toMatch(/The hosted dashboard has no public\s+signup\./);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it.each(PUBLIC_ENTRYPOINTS)('gives $path an exact self-canonical', (entry) => {
    const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const html = renderPublicEntrypoint(indexHtml, entry);
    const canonical = `https://health.sassmaker.com${entry.path}`;
    expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}" />`);
    expect(html).toContain(`<title>${entry.title}</title>`);
  });

  it('unlocks with an owner key without persisting it in browser storage', async () => {
    const onUnlock = vi.fn();
    const listed = { apps: [] };
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer aho_owner-secret');
      return Response.json(listed);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<OwnerUnlock onUnlock={onUnlock} />);
    const input = screen.getByLabelText('Owner key');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'aho_owner-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('aho_owner-secret', listed));
    expect([...storageValues.values()].join('')).not.toContain('aho_owner-secret');
  });

  it('starts with the focused project setup flow', () => {
    installFetch();
    render(<App />);
    expect(screen.getByRole('heading', { name: /know which routes are healthy/i })).toBeTruthy();
    expect(screen.getByLabelText('Application name')).toBeTruthy();
    expect(screen.getByText(/no payload storage/i)).toBeTruthy();
  });

  it('shows a newly-created key once and never persists the raw key', async () => {
    installFetch({
      status: {
        state: 'waiting',
        first_seen: null,
        last_seen: null,
        next_action: 'Start your service.',
      },
      endpointRows: [],
    });
    render(<App />);
    fireEvent.change(screen.getByLabelText('Application name'), {
      target: { value: 'orders-api' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));
    expect(await screen.findByText('ahk_one_time_secret')).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('ahk_one_time_secret');
    fireEvent.click(screen.getByRole('button', { name: /i saved the key/i }));
    expect(await screen.findByText('Waiting for traffic')).toBeTruthy();
    expect(screen.queryByText('ahk_one_time_secret')).toBeNull();
  });

  it('shows copy-ready SDK and OpenTelemetry setup without persisting the key', async () => {
    installFetch();
    render(<App />);
    fireEvent.change(screen.getByLabelText('Application name'), {
      target: { value: 'orders-api' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect(
      await screen.findByText(
        /npm install https:\/\/github\.com\/sass-maker\/app-health\/releases\/download\/node-v0\.2\.1\/saas-maker-app-health-0\.2\.1\.tgz/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/@saas-maker\/app-health\/express/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Hono Worker' }));
    expect(screen.getByText(/@saas-maker\/app-health\/hono/)).toBeTruthy();
    expect(screen.getByText(/runtime: 'worker'/)).toBeTruthy();
    expect(screen.getByText(/disableTimer: true/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Pages Functions' }));
    expect(screen.getByText(/@saas-maker\/app-health\/pages/)).toBeTruthy();
    expect(screen.getByText(/withPagesFunctionHealth/)).toBeTruthy();
    expect(screen.getByText(/route: '\/users\/:id'/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Go + Echo' }));
    expect(
      screen.getByText(
        /go get github\.com\/sarthakagrawal927\/app-health\/packages\/go\/echo\/v5@v5\.1\.0/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/apphealthechov5\.Install/)).toBeTruthy();
    expect(screen.getByText(/Enabled: true/)).toBeTruthy();
    expect(screen.getByText(/Environment: "production"/)).toBeTruthy();
    expect(screen.getByText(/Project: "orders-api"/)).toBeTruthy();
    expect(screen.queryByText(/IngestURL/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Existing OpenTelemetry' }));
    expect(screen.getByText(/otlphttp\/app_health/)).toBeTruthy();
    expect(screen.getByText(/\/v1\/traces/)).toBeTruthy();
    expect(screen.getByText(/Bearer ahk_one_time_secret/)).toBeTruthy();
    expect(screen.getByText(/Reload your Collector/)).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('ahk_one_time_secret');
  });

  it('identifies OpenTelemetry traffic and discloses sampled endpoint estimates', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: { ...connected, runtime: 'otel' },
      endpointRows: [{ ...endpoints[0], upstream_sampled: true }],
    });
    render(<App />);
    expect(await screen.findByText('OpenTelemetry connected')).toBeTruthy();
    expect(screen.getByText(/OpenTelemetry pipeline/)).toBeTruthy();
    expect(screen.getAllByText('OTel sampled estimate')).toHaveLength(2);
  });

  it('switches every dashboard query between environments under one product', async () => {
    const localProject = {
      appId: 'app-polaris',
      environmentId: 'env-polaris-local',
      name: 'polaris',
      environment: 'local',
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localProject));
    const fetchMock = installFetch({
      apps: [
        {
          app: { id: 'app-polaris', name: 'polaris', created_at: Date.now() },
          environments: [
            {
              id: 'env-polaris-local',
              app_id: 'app-polaris',
              name: 'local',
              created_at: Date.now(),
            },
            {
              id: 'env-polaris-staging',
              app_id: 'app-polaris',
              name: 'staging',
              created_at: Date.now(),
            },
          ],
        },
      ],
    });

    render(<App />);
    const environment = await screen.findByRole('combobox', { name: 'Environment' });
    expect(environment).toHaveValue('env-polaris-local');
    fireEvent.change(environment, { target: { value: 'env-polaris-staging' } });

    await waitFor(() => {
      const scopedCalls = fetchMock.mock.calls
        .map(([input]) => (input instanceof URL ? input : null))
        .filter(
          (url): url is URL =>
            url !== null &&
            ['/v1/endpoints', '/v1/installation/status'].includes(url.pathname) &&
            url.searchParams.get('environment_id') === 'env-polaris-staging',
        );
      expect(scopedCalls.map((url) => url.pathname).sort()).toEqual([
        '/v1/endpoints',
        '/v1/installation/status',
      ]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Data received' }));
    await waitFor(() => {
      const failureCall = fetchMock.mock.calls
        .map(([input]) => (input instanceof URL ? input : null))
        .find(
          (url) =>
            url?.pathname === '/v1/failures' &&
            url.searchParams.get('environment_id') === 'env-polaris-staging' &&
            url.searchParams.get('window') === '15m',
        );
      expect(failureCall).toBeDefined();
    });
    expect(localStorage.getItem(STORAGE_KEY)).toContain('env-polaris-staging');
  });

  it('replaces a cached project that the authenticated key cannot access', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        appId: 'app-demo',
        environmentId: 'env-demo',
        name: 'App Health Demo',
        environment: 'demo',
      }),
    );
    installFetch({
      apps: [
        {
          app: { id: 'app-polaris', name: 'Polaris', created_at: Date.now() },
          environments: [
            {
              id: 'env-polaris-local',
              app_id: 'app-polaris',
              name: 'local',
              created_at: Date.now(),
            },
          ],
        },
      ],
    });

    render(<App />);

    expect(await screen.findByText('Polaris')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveValue('env-polaris-local');
    expect(localStorage.getItem(STORAGE_KEY)).toContain('app-polaris');
  });

  it('identifies Cloudflare Worker traffic', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: { ...connected, runtime: 'worker' },
    });
    render(<App />);
    expect(await screen.findByText('Cloudflare Worker connected')).toBeTruthy();
    expect(screen.getByText(/Cloudflare Worker is sending endpoint summaries/)).toBeTruthy();
  });

  it('labels seeded fixtures without claiming an SDK connection', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...savedProject, appId: SEED_APP_ID }));
    installFetch();
    render(<App />);
    expect(await screen.findByText('Sample data')).toBeTruthy();
    expect(screen.getByText(/seeded fixtures, not traffic received from an SDK/)).toBeTruthy();
    expect(screen.queryByText('SDK connected')).toBeNull();
  });

  it('renders populated endpoint metrics and changes windows', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    const fetchMock = installFetch();
    render(<App />);
    expect(await screen.findAllByText('/orders')).toHaveLength(2);
    expect(screen.getAllByText(/low volume/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      const endpointCalls = fetchMock.mock.calls
        .map(([input]) => (input instanceof URL ? input : null))
        .filter((url): url is URL => url?.pathname === '/v1/endpoints');
      expect(endpointCalls.at(-1)?.searchParams.get('window')).toBe('1h');
    });
  });

  it('loads retained failures only after the owner opens Data received', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    const fetchMock = installFetch({
      failureRows: [
        {
          failure_id: '00000000-0000-4000-a000-000000000001',
          method: 'POST',
          route: '/orders/:id',
          status_code: 503,
          duration_ms: 812,
          occurred_at: Date.now() - 4_000,
          release: '2026.07.22',
        },
      ],
    });
    render(<App />);
    await screen.findAllByText('/orders');
    expect(
      fetchMock.mock.calls.some(
        ([input]) => input instanceof URL && input.pathname === '/v1/failures',
      ),
    ).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Data received' }));
    expect(await screen.findByText('/orders/:id')).toBeTruthy();
    expect(screen.getByText('503')).toBeTruthy();
    expect(screen.getByText('812 ms')).toBeTruthy();
    const detailsButton = screen.getByRole('button', {
      name: 'View details for POST /orders/:id 503',
    });
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(detailsButton);
    expect(screen.getByText('Retained failure detail')).toBeTruthy();
    expect(screen.getByText('Exact fields kept for this failed request')).toBeTruthy();
    expect(screen.getByText(/No request body, headers, query values/i)).toBeTruthy();
    const hideDetailsButton = screen.getByRole('button', {
      name: 'Hide details for POST /orders/:id 503',
    });
    expect(hideDetailsButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hideDetailsButton);
    expect(screen.queryByText('Retained failure detail')).toBeNull();
    expect(screen.getByText('The complete accepted shape')).toBeTruthy();
    expect(screen.getByText('Request bodies')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(
        ([input]) => input instanceof URL && input.pathname === '/v1/failures',
      ),
    ).toBe(true);
  });

  it('keeps the collection policy visible when failure details cannot load', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ failureFail: true });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Data received' }));
    expect(await screen.findByText('Failure details are unavailable')).toBeTruthy();
    expect(screen.getByText('Never collected')).toBeTruthy();
    expect(screen.getByText(/2xx and 3xx requests are folded into counts/i)).toBeTruthy();
  });

  it('shows sampled-out endpoint identities without false zero metrics', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      endpointRows: [
        {
          method: 'POST',
          route: '/rare',
          request_count: 0,
          error_count: 0,
          error_rate: 0,
          p50_ms: 0,
          p95_ms: 0,
          last_seen: Date.now(),
          health_state: 'insufficient-data',
          metrics_available: false,
        },
      ],
    });
    render(<App />);
    expect(await screen.findAllByText('/rare')).toHaveLength(2);
    expect(screen.getAllByText('metrics sampled')).toHaveLength(2);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('renders the waiting and no-traffic state with a concrete next action', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: {
        state: 'waiting',
        first_seen: null,
        last_seen: null,
        next_action: 'Start your service.',
      },
      endpointRows: [],
    });
    render(<App />);
    expect(await screen.findByText('Waiting for traffic')).toBeTruthy();
    expect(screen.getByText('No endpoints observed yet')).toBeTruthy();
    expect(screen.getByText(/curl http:\/\/localhost:3000\/health/)).toBeTruthy();
  });

  it('explains stale and revoked installation states', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: {
        state: 'stale',
        runtime: 'go',
        first_seen: Date.now() - 100_000,
        last_seen: Date.now() - 90_000,
        next_action: 'Restart the service.',
      },
      endpointRows: [],
    });
    const { unmount } = render(<App />);
    expect(await screen.findByText('Traffic has gone quiet')).toBeTruthy();
    unmount();
    installFetch({
      status: {
        state: 'revoked',
        first_seen: null,
        last_seen: null,
        next_action: 'Create a key.',
      },
      endpointRows: [],
    });
    render(<App />);
    expect(await screen.findByText('Ingest key revoked')).toBeTruthy();
  });

  it('explains the error installation state', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: {
        state: 'error',
        first_seen: null,
        last_seen: null,
        next_action: 'Retry.',
      },
      endpointRows: [],
    });
    render(<App />);
    expect(await screen.findByText('Installation check unavailable')).toBeTruthy();
    expect(screen.getByText(/could not verify this installation/i)).toBeTruthy();
  });

  it('identifies connected traffic without a runtime label', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: { ...connected, runtime: undefined },
    });
    render(<App />);
    expect(await screen.findByText('SDK connected')).toBeTruthy();
    expect(screen.getByText('Endpoint summaries are arriving.')).toBeTruthy();
  });

  it('shows an actionable API failure without hiding the app shell', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ fail: true });
    render(<App />);
    expect(await screen.findByText('Can’t refresh endpoint data')).toBeTruthy();
    expect(screen.getByText(/application is unaffected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Logs view', () => {
  const logRows: StoredLogV1[] = [
    {
      log_id: '00000000-0000-4000-a000-000000000101',
      timestamp: Date.now() - 5_000,
      event: 'signup',
      level: 'info',
      source: 'server',
      title: 'ada@example.com',
      props: { plan: 'free', seats: 2, trial: true, ref: null },
    },
    {
      log_id: '00000000-0000-4000-a000-000000000102',
      timestamp: Date.now() - 65_000,
      event: 'payment.failed',
      level: 'error',
      source: 'browser',
      icon: '💳',
      description: 'card declined',
      props: {},
    },
  ];

  beforeEach(() => {
    vi.stubGlobal('localStorage', storage);
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads logs only after the owner opens Logs and filters by level and event', async () => {
    const fetchMock = installFetch({ logRows });
    render(<App />);
    await screen.findAllByText('/orders');
    const logCalls = () =>
      fetchMock.mock.calls.filter(
        ([input]) => input instanceof URL && input.pathname === '/v1/logs',
      );
    expect(logCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('payment.failed')).toBeTruthy();
    expect(screen.getByText('card declined')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Time window' })).toBeNull();
    const firstCall = logCalls()[0][0] as URL;
    expect(firstCall.searchParams.get('app_id')).toBe('app-test');
    expect(firstCall.searchParams.get('level')).toBe('debug');

    fireEvent.change(screen.getByRole('combobox', { name: 'Minimum level' }), {
      target: { value: 'warn' },
    });
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
    expect(screen.getByText('payment.failed')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Minimum level' }), {
      target: { value: 'debug' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
      target: { value: 'signup' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByText('payment.failed')).toBeNull());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    const lastCall = logCalls().at(-1)?.[0] as URL;
    expect(lastCall.searchParams.get('event')).toBe('signup');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(logCalls().length).toBeGreaterThan(3));
  });

  it('shows a browser badge, filters by source, and manages browser keys', async () => {
    const fetchMock = installFetch({
      logRows,
      publicKeys: [
        {
          id: 'pubkey-existing',
          app_id: 'app-test',
          environment_id: 'env-test',
          allowed_origins: ['https://karte.app'],
          created_at: Date.now() - 100_000,
          revoked_at: null,
        },
        {
          id: 'pubkey-other-env',
          app_id: 'app-test',
          environment_id: 'env-other',
          allowed_origins: ['https://other.app'],
          created_at: Date.now() - 100_000,
          revoked_at: null,
        },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('payment.failed')).toBeTruthy();
    expect(document.querySelector('.log-source')?.textContent).toBe('browser');

    fireEvent.change(screen.getByRole('combobox', { name: 'Source' }), {
      target: { value: 'server' },
    });
    await waitFor(() => expect(screen.queryByText('payment.failed')).toBeNull());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    const sourceCall = fetchMock.mock.calls
      .map(([input]) => input)
      .filter((input): input is URL => input instanceof URL && input.pathname === '/v1/logs')
      .at(-1);
    expect(sourceCall?.searchParams.get('source')).toBe('server');

    expect(await screen.findByText('Browser logging keys (1 active)')).toBeTruthy();
    expect(screen.getByText('https://karte.app')).toBeTruthy();
    expect(screen.queryByText('https://other.app')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Allowed origins' }), {
      target: { value: 'https://new.app/, http://localhost:5173' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create browser key' }));
    expect(await screen.findByText('ahk_pub_one_time_value')).toBeTruthy();
    expect(screen.getByText(/createWebLogger/)).toBeTruthy();
    const createCall = fetchMock.mock.calls.find(
      ([input, init]) => String(input).endsWith('/v1/public-keys') && init?.method === 'POST',
    );
    expect(JSON.parse(String(createCall?.[1]?.body)).allowed_origins).toEqual([
      'https://new.app',
      'http://localhost:5173',
    ]);
    expect(await screen.findByText('https://new.app, http://localhost:5173')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke browser key pubkey-existing' }));
    expect(await screen.findByText(/revoked/)).toBeTruthy();
  });

  it('reports browser key API failures without hiding the logs', async () => {
    installFetch({ logRows, publicKeyFail: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(await screen.findByText('API returned 503')).toBeTruthy();
  });

  it('shows the empty state with a next action and recovers from an API failure', async () => {
    installFetch({ logRows: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('No logs match')).toBeTruthy();
    expect(screen.getByText(/POST/)).toBeTruthy();
  });

  it('keeps the shell usable when logs cannot load', async () => {
    installFetch({ logFail: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('Logs are unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Endpoints' })).toBeTruthy();
  });
});

describe('sortEndpoints', () => {
  it('sorts stably across requests, health, error, p95, and last seen', () => {
    expect(sortEndpoints(endpoints, 'requests', 'desc')[0].route).toBe('/orders');
    expect(sortEndpoints(endpoints, 'health', 'desc')[0].health_state).toBe('unhealthy');
    expect(sortEndpoints(endpoints, 'error_rate', 'asc')[0].route).toBe('/health');
    expect(sortEndpoints(endpoints, 'p95', 'desc')[0].p95_ms).toBe(2400);
    expect(sortEndpoints(endpoints, 'last_seen', 'desc')[0].route).toBe('/orders');
  });

  it('keeps endpoints without sampled metrics below measured endpoints', () => {
    const sampledOut = { ...endpoints[0], route: '/rare', metrics_available: false };
    expect(sortEndpoints([sampledOut, ...endpoints], 'requests', 'asc').at(-1)?.route).toBe(
      '/rare',
    );
  });
});
