import {
  updateWorkspaceRole,
  workspaceScope,
  selectWorkspace,
} from '../src/lib/workspace-scope.js';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  CapabilityState,
  EnvironmentCapabilities,
} from '@app-health/contracts';

const STORAGE_KEY = 'app-health-v0-project';

function expectSelectedProject(name: string) {
  expect(screen.getByRole('button', { name })).toHaveAttribute('data-active', 'true');
  expect(
    within(screen.getByRole('group', { name: 'Project context' })).getByText(name, { exact: true }),
  ).toBeVisible();
}

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
  google?: boolean;
  appsFail?: boolean;
  signOutFail?: boolean;
  capabilityRows?: CapabilityState[];
  capabilityFail?: boolean;
  capabilitySaveFail?: boolean;
  privateKey?: EnvironmentCapabilities['private_key'];
  environmentCreateFail?: boolean;
  environmentCreateInvalid?: boolean;
  keyIssueFail?: boolean;
  keyIssueInvalid?: boolean;
  endpointInvalid?: boolean;
  endpointPending?: boolean;
  endpointFailWindow?: string;
  statusInvalid?: boolean;
  workspaceRole?: 'owner' | 'editor' | 'viewer';
}) {
  const publicKeys = [...(options?.publicKeys ?? [])];
  let signedOut = false;
  let failedWindow = options?.endpointFailWindow ?? null;
  let capabilityRows =
    options?.capabilityRows ??
    (['analytics', 'endpoints', 'logs'] as const).map((id) => ({
      id,
      enabled: true,
      first_received_at: Date.now() - 60_000,
      last_received_at: Date.now() - 5_000,
    }));
  const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url, window.location.origin);
    if (url.pathname === '/v1/account/config')
      return Response.json({ google: options?.google ?? false });
    if (url.pathname === '/v1/capabilities') {
      if (options?.capabilityFail) return new Response(null, { status: 503 });
      if (init?.method === 'PUT') {
        if (options?.capabilitySaveFail) return new Response(null, { status: 503 });
        const enabled = (JSON.parse(String(init.body)) as { enabled: string[] }).enabled;
        capabilityRows = capabilityRows.map((row) => ({
          ...row,
          enabled: enabled.includes(row.id),
        }));
      }
      return Response.json({
        app_id: url.searchParams.get('app_id'),
        environment_id: url.searchParams.get('environment_id'),
        capabilities: capabilityRows,
        private_key:
          options && 'privateKey' in options
            ? options.privateKey
            : {
                id: 'key-current',
                environment_id: url.searchParams.get('environment_id'),
                created_at: Date.now() - 100_000,
                revoked_at: null,
              },
      });
    }
    const createEnvironment = url.pathname.match(/^\/v1\/apps\/([^/]+)\/environments$/);
    if (createEnvironment && init?.method === 'POST') {
      if (options?.environmentCreateFail) return new Response(null, { status: 503 });
      if (options?.environmentCreateInvalid) return Response.json({ environment: {} });
      const body = JSON.parse(String(init.body)) as { name: string };
      return new Response(
        JSON.stringify({
          environment: {
            id: `env-${body.name}`,
            app_id: createEnvironment[1],
            name: body.name,
            created_at: Date.now(),
          },
          key: {
            key: `ahk_${body.name}_one_time`,
            app_id: createEnvironment[1],
            environment_id: `env-${body.name}`,
            created_at: Date.now(),
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    const issueKey = url.pathname.match(/^\/v1\/apps\/([^/]+)\/environments\/([^/]+)\/keys$/);
    if (issueKey && init?.method === 'POST') {
      if (options?.keyIssueFail) return new Response(null, { status: 503 });
      if (options?.keyIssueInvalid) return Response.json({ key: {} });
      return new Response(
        JSON.stringify({
          environment: {
            id: issueKey[2],
            app_id: issueKey[1],
            name: savedProject.environment,
            created_at: Date.now(),
          },
          key: {
            key: 'ahk_environment_one_time',
            app_id: issueKey[1],
            environment_id: issueKey[2],
            created_at: Date.now(),
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (options?.fail) throw new Error('connection refused');
    if (url.pathname === '/v1/auth/sign-out') {
      if (!options?.signOutFail) signedOut = true;
      return new Response('{}', { status: options?.signOutFail ? 503 : 200 });
    }
    if (url.pathname === '/v1/apps') {
      if (options?.appsFail || signedOut) return new Response(null, { status: 403 });
      if (init?.method !== 'POST')
        return Response.json(
          { apps: options?.apps ?? [] },
          { headers: { 'x-app-health-workspace-role': options?.workspaceRole ?? 'owner' } },
        );
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
      if (options?.statusInvalid) return Response.json({ state: 'connected' });
      return Response.json(options?.status ?? connected);
    }
    if (url.pathname === '/v1/endpoints') {
      if (options?.endpointInvalid) return Response.json({ endpoints: [] });
      if (url.searchParams.get('window') === failedWindow) {
        failedWindow = null;
        return new Response(null, { status: 503 });
      }
      if (options?.endpointPending)
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
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

async function openKeySetup(): Promise<void> {
  installFetch();
  render(<App />);
  fireEvent.change(screen.getByLabelText('application name'), {
    target: { value: 'orders-api' },
  });
  fireEvent.click(screen.getByRole('button', { name: /create project/i }));
  await screen.findByText('ahk_one_time_secret');
}

describe('App Health V0 UI', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage);
    localStorage.clear();
    window.history.replaceState({}, '', '/app#backend');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['viewer', 'unknown'] as const)(
    'does not mount key or admin effects for %s deep links',
    async (role) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
      selectWorkspace('');
      window.history.replaceState({}, '', '/app#analytics/setup');
      const mock = installFetch({ workspaceRole: 'viewer' });
      if (role === 'unknown')
        vi.stubGlobal(
          'fetch',
          vi.fn((input: URL | RequestInfo, init?: RequestInit) =>
            new URL(String(input), location.origin).pathname === '/v1/apps'
              ? new Promise<Response>(() => {})
              : mock(input, init),
          ),
        );
      else updateWorkspaceRole('viewer', workspaceScope().epoch);
      render(<App />);
      expect(
        await screen.findByText('Browser key setup requires confirmed editor or owner access.'),
      ).toBeVisible();
      expect(
        mock.mock.calls.some(
          ([input]) => new URL(String(input), location.origin).pathname === '/v1/public-keys',
        ),
      ).toBe(false);
      await act(async () => {
        history.replaceState({}, '', '/app#settings');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(await screen.findByRole('heading', { name: 'settings' })).toBeVisible();
      expect(screen.queryByRole('button', { name: 'connect payment provider' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'create key' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'import fleet catalog' })).toBeNull();
      expect(
        mock.mock.calls.some(([input]) =>
          [
            '/v1/public-keys',
            '/v1/payment-connections',
            '/v1/native-keys',
            '/v1/analytics/shares',
          ].includes(new URL(String(input), location.origin).pathname),
        ),
      ).toBe(false);
    },
  );

  it('resolves a valid explicit analytics link without local storage', async () => {
    const apps = [
      {
        app: { id: 'app-alpha', name: 'alpha', created_at: Date.now() },
        environments: [
          { id: 'env-alpha', app_id: 'app-alpha', name: 'production', created_at: Date.now() },
        ],
      },
    ];
    window.history.replaceState({}, '', '/app?project=app-alpha&environment=env-alpha#analytics');
    installFetch({ apps });
    render(<App />);
    await screen.findByRole('button', { name: 'alpha' });
    expectSelectedProject('alpha');
    expect(localStorage.getItem(STORAGE_KEY)).toContain('app-alpha');
  });

  it('does not replace an explicit target after selecting another project', async () => {
    const apps = ['alpha', 'beta'].map((name) => ({
      app: { id: `app-${name}`, name, created_at: Date.now() },
      environments: [
        { id: `env-${name}`, app_id: `app-${name}`, name: 'production', created_at: Date.now() },
      ],
    }));
    window.history.replaceState({}, '', '/app?project=app-alpha&environment=env-alpha#analytics');
    installFetch({ apps });
    render(<App />);
    await screen.findByRole('button', { name: 'alpha' });
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    expect(new URL(window.location.href).searchParams.get('project')).toBe('app-beta');
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    expectSelectedProject('beta');
  });

  it('shows a retryable error when an explicit target inventory request is forbidden', async () => {
    window.history.replaceState({}, '', '/app?project=foreign&environment=prod#analytics');
    installFetch({ appsFail: true });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('project list could not load');
    expect(screen.queryByRole('button', { name: 'create project' })).toBeNull();
  });

  it('restores the selected project when browser history changes the URL target', async () => {
    const apps = ['alpha', 'beta'].map((name) => ({
      app: { id: `app-${name}`, name, created_at: Date.now() },
      environments: [
        { id: `env-${name}`, app_id: `app-${name}`, name: 'production', created_at: Date.now() },
      ],
    }));
    window.history.replaceState({}, '', '/app?project=app-alpha&environment=env-alpha#analytics');
    installFetch({ apps });
    render(<App />);
    await screen.findByRole('button', { name: 'alpha' });
    expectSelectedProject('alpha');
    await act(async () => {
      window.history.pushState({}, '', '/app?project=app-beta&environment=env-beta#analytics');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expectSelectedProject('beta'));
    await act(async () => {
      window.history.pushState({}, '', '/app?project=app-alpha&environment=env-alpha#analytics');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expectSelectedProject('alpha'));
  });

  it('keeps credentials hidden until both configuration and the existing session resolve', async () => {
    vi.stubEnv('DEV', false);
    let resolveConfig!: (response: Response) => void;
    let resolveSession!: (response: Response) => void;
    const config = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    const session = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string) => (input === '/v1/account/config' ? config : session)),
    );
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(screen.queryByLabelText('owner key')).toBeNull();
    expect(screen.getByLabelText('Loading workspace project')).toBeVisible();
    await act(async () => resolveConfig(Response.json({ google: true })));
    expect(screen.queryByLabelText('owner key')).toBeNull();
    expect(screen.getByLabelText('Loading workspace project')).toBeVisible();
    await act(async () => resolveSession(Response.json({ apps: [] })));
    expect(await screen.findByRole('button', { name: 'create project' })).toBeVisible();
    expect(screen.queryByLabelText('owner key')).toBeNull();
  });

  it('shows the legacy owner-key mode only after configuration explicitly disables Google', async () => {
    vi.stubEnv('DEV', false);
    let resolveConfig!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveConfig = resolve;
          }),
      ),
    );
    render(<App />);
    expect(screen.queryByLabelText('owner key')).toBeNull();
    await act(async () => resolveConfig(Response.json({ google: false })));
    expect(await screen.findByLabelText('owner key')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'continue with Google' })).toBeNull();
  });

  it.each(['config', 'session', 'network', 'invalid-config'])(
    'retries a failed %s bootstrap without silently falling back to a key',
    async (failure) => {
      vi.stubEnv('DEV', false);
      let failing = true;
      const fetchMock = vi.fn(async (input: string) => {
        if (input === '/v1/account/config') {
          if (failing && failure === 'network') throw new Error('offline');
          if (failing && failure === 'config') return new Response(null, { status: 503 });
          if (failing && failure === 'invalid-config') return Response.json({});
          return Response.json({ google: true });
        }
        return new Response(null, { status: failing ? 503 : 403 });
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<App />);
      expect(await screen.findByRole('alert')).toHaveTextContent('could not open the workspace');
      expect(screen.queryByLabelText('owner key')).toBeNull();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'try again' }));
      expect(await screen.findByRole('button', { name: 'continue with Google' })).toBeVisible();
      expect(fetchMock.mock.calls.filter(([input]) => input === '/v1/account/config')).toHaveLength(
        2,
      );
    },
  );

  it('resumes a Google workspace once in StrictMode, switches projects, and signs out without persisting credentials', async () => {
    vi.stubEnv('DEV', false);
    const apps = ['alpha', 'beta'].map((name) => ({
      app: { id: `app-${name}`, name, created_at: Date.now() },
      environments: [
        { id: `env-${name}`, app_id: `app-${name}`, name: 'production', created_at: Date.now() },
      ],
    }));
    const mock = installFetch({ google: true, apps });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByRole('button', { name: 'alpha' });
    expectSelectedProject('alpha');
    // Production bootstrap reuses its inventory even under StrictMode effect replay.
    expect(
      mock.mock.calls.filter(
        ([input, init]) => String(input).endsWith('/v1/apps') && (init?.method ?? 'GET') === 'GET',
      ),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'beta' }));
    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY)).toContain('app-beta');
      expectSelectedProject('beta');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add another project' }));
    expect(await screen.findByRole('button', { name: 'back to projects' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'create project' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'back to projects' }));
    const beforeSignOutEpoch = workspaceScope().epoch;
    fireEvent.click(await screen.findByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(workspaceScope().epoch).toBeGreaterThan(beforeSignOutEpoch));
    expect(workspaceScope().id).toBe('');
    expect(await screen.findByRole('button', { name: 'continue with Google' })).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(
      mock.mock.calls.filter(([input]) => String(input).includes('/v1/auth/sign-out')),
    ).toHaveLength(1);
    expect(
      mock.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization')),
    ).toBe(true);
  });

  it('keeps a failed sign-out recoverable, including an empty workspace', async () => {
    installFetch({ google: true, signOutFail: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not sign out');
    expect(screen.getByRole('button', { name: 'create project' })).toBeTruthy();
  });

  it('keeps Google sign-in available when the signed-out inventory probe is unauthorized', async () => {
    vi.stubEnv('DEV', false);
    installFetch({ google: true, appsFail: true });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'continue with Google' })).toBeTruthy();
  });

  it('offers Google sign-in and reports provider failures without losing the deployment-key option', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
    render(<OwnerUnlock onUnlock={vi.fn()} googleEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'continue with Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Google sign-in could not start');
    expect(screen.getByRole('button', { name: 'unlock' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'continue with Google' })).toBeEnabled();
  });

  it('rejects unexpected OAuth destinations and explains callback failure', async () => {
    window.history.replaceState({}, '', '/?signin=failed');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ url: 'https://evil.example.com' })),
    );
    render(<OwnerUnlock onUnlock={vi.fn()} googleEnabled />);
    expect(screen.getByRole('alert')).toHaveTextContent('sign-in did not complete');
    fireEvent.click(screen.getByRole('button', { name: 'continue with Google' }));
    expect(await screen.findByText('unexpected sign-in destination.')).toBeTruthy();
  });

  it('renders the product-led landing hero in the initial HTML response', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

    expect(html).toContain('data-initial-landing-shell');
    expect(html).toContain('<h1 id="unlock-title">see what people do. know what to improve.</h1>');
    expect(html).toContain('Named product events and trends');
    expect(html).toContain('one browser script');
    expect(html).toContain('local preview available');
    expect(html).toContain('open App Health');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it('serves the private app from an empty, theme-stable HTML document', () => {
    const html = readFileSync(resolve(process.cwd(), 'app.html'), 'utf8');

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain("localStorage.getItem('app-health-theme')");
    expect(html).not.toContain('data-initial-landing-shell');
    expect(html).not.toContain('see what people do. know what to improve.');
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
    const input = screen.getByLabelText('owner key');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'aho_owner-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'unlock' }));
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('aho_owner-secret', listed));
    expect([...storageValues.values()].join('')).not.toContain('aho_owner-secret');
  });

  it('starts with the focused project setup flow', () => {
    installFetch();
    render(<App />);
    expect(
      screen.getByRole('heading', { name: /start with a product you want to understand/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText('application name')).toBeTruthy();
    expect(screen.getByText(/named product events/i)).toBeTruthy();
  });

  it('shows a newly-created key once and never persists the raw key', async () => {
    await openKeySetup();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('ahk_one_time_secret');
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith('/v1/apps') && init?.method === 'POST',
      );
    expect(JSON.parse(String(createCall?.[1]?.body)).key_scope).toBe('environment');
    fireEvent.click(screen.getByRole('button', { name: /save key and choose capabilities/i }));
    expect(await screen.findByRole('heading', { name: 'settings' })).toBeTruthy();
    expect(screen.queryByText('ahk_one_time_secret')).toBeNull();
  });

  it('shows copy-ready SDK and OpenTelemetry setup without persisting the key', async () => {
    await openKeySetup();

    expect(
      await screen.findByText(
        /npm install https:\/\/github\.com\/sass-maker\/app-health\/releases\/download\/node-v0\.4\.0\/saas-maker-app-health-0\.4\.0\.tgz/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/@saas-maker\/app-health\/express/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Hono worker' }));
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
    fireEvent.click(screen.getByRole('tab', { name: 'existing OpenTelemetry' }));
    expect(screen.getByText(/otlphttp\/app_health/)).toBeTruthy();
    expect(screen.getByText(/\/v1\/traces/)).toBeTruthy();
    expect(screen.getByText(/Bearer ahk_one_time_secret/)).toBeTruthy();
    expect(screen.getByText(/reload your collector/)).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('ahk_one_time_secret');
  });

  it('keeps the key selectable and reports when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: undefined }));
    await openKeySetup();

    fireEvent.click(screen.getByRole('button', { name: 'copy key' }));

    expect(await screen.findByText('automatic copy unavailable')).toBeTruthy();
    expect(screen.getByText(/select the key above and copy it manually/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'copy key' })).toBeTruthy();
    expect(screen.getByText('ahk_one_time_secret')).toBeTruthy();
  });

  it('keeps the snippet visible and reports a rejected clipboard write', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), { clipboard: { writeText } }),
    );
    await openKeySetup();

    fireEvent.click(screen.getByRole('button', { name: 'copy snippet' }));

    expect(await screen.findByText('automatic copy unavailable')).toBeTruthy();
    expect(screen.getByText(/select the snippet above and copy it manually/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'copy snippet' })).toBeTruthy();
    expect(screen.getByText(/@saas-maker\/app-health\/express/)).toBeTruthy();
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0]).toContain('@saas-maker/app-health/express');
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

  it('labels storage-sampled measurements without attributing them to OpenTelemetry', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ status: connected, endpointRows: [{ ...endpoints[0], sampled: true }] });
    render(<App />);
    expect(await screen.findAllByText('sampled estimate')).toHaveLength(2);
    expect(screen.queryByText('OTel sampled estimate')).toBeNull();
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
    expect(environment).toHaveTextContent('local');
    fireEvent.keyDown(environment, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'staging' }));

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
    fireEvent.click(screen.getByRole('tab', { name: 'diagnostics' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'polaris' }));
    expectSelectedProject('polaris');
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('staging');
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

    await waitFor(() => expectSelectedProject('Polaris'));
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('local');
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
    expect(await screen.findByText('sample data')).toBeTruthy();
    expect(screen.getByText(/seeded fixtures, not traffic received from an SDK/)).toBeTruthy();
    expect(screen.queryByText('SDK connected')).toBeNull();
  });

  it('renders populated endpoint metrics and changes windows', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    const fetchMock = installFetch();
    render(<App />);
    expect(await screen.findAllByText('/orders')).toHaveLength(2);
    expect(screen.getAllByText('≤ 180 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('≤ 2,400 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/insufficient data/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      const endpointCalls = fetchMock.mock.calls
        .map(([input]) => (input instanceof URL ? input : null))
        .filter((url): url is URL => url?.pathname === '/v1/endpoints');
      expect(endpointCalls.at(-1)?.searchParams.get('window')).toBe('1h');
    });
  });

  it('rejects an invalid dashboard endpoint contract', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ endpointInvalid: true });
    render(<App />);
    expect(await screen.findByText('can’t refresh endpoint data')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid endpoint data response');
  });

  it('rejects an invalid installation status contract', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ statusInvalid: true });
    render(<App />);
    expect(await screen.findByText('can’t refresh endpoint data')).toBeTruthy();
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid installation status response');
  });

  it('clears endpoint data and aborts the prior window request', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    const fetchMock = installFetch({ endpointPending: true });
    render(<App />);
    expect(await screen.findByText('loading endpoint count…')).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(2));
    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    await waitFor(() => {
      const endpointCalls = fetchMock.mock.calls.filter(
        ([input]) => input instanceof URL && input.pathname === '/v1/endpoints',
      );
      expect(endpointCalls.at(-1)?.[0]).toHaveProperty('searchParams');
      expect((endpointCalls.at(-1)?.[0] as URL).searchParams.get('window')).toBe('1h');
    });
    const firstEndpointCall = fetchMock.mock.calls.find(
      ([input]) => input instanceof URL && input.pathname === '/v1/endpoints',
    );
    expect(firstEndpointCall?.[1]?.signal).toHaveProperty('aborted', true);
    expect(screen.queryByText('/orders')).toBeNull();
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

    fireEvent.click(screen.getByRole('tab', { name: 'diagnostics' }));
    expect(await screen.findByText('/orders/:id')).toBeTruthy();
    expect(screen.getByText('503')).toBeTruthy();
    expect(screen.getByText('812 ms')).toBeTruthy();
    const detailsButton = screen.getByRole('button', {
      name: 'View details for POST /orders/:id 503',
    });
    expect(detailsButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(detailsButton);
    expect(screen.getByText('retained failure detail')).toBeTruthy();
    expect(screen.getByText('exact fields kept for this failed request')).toBeTruthy();
    expect(screen.getByText(/No request body, headers, query values/i)).toBeTruthy();
    const hideDetailsButton = screen.getByRole('button', {
      name: 'Hide details for POST /orders/:id 503',
    });
    expect(hideDetailsButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hideDetailsButton);
    expect(screen.queryByText('retained failure detail')).toBeNull();
    expect(screen.getByText('the complete accepted shape')).toBeTruthy();
    expect(screen.getByText('request bodies')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('tab', { name: 'diagnostics' }));
    expect(await screen.findByText('failure details are unavailable')).toBeTruthy();
    expect(screen.getByText('never collected')).toBeTruthy();
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
    expect(screen.getAllByText('metrics unavailable')).toHaveLength(2);
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
    expect(await screen.findByText('waiting for traffic')).toBeTruthy();
    expect(screen.getByRole('status')).toHaveTextContent(/^0 observed/);
    expect(screen.getByText('no endpoints observed yet')).toBeTruthy();
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
    expect(await screen.findByText('traffic has gone quiet')).toBeTruthy();
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
    expect(await screen.findByText('ingest key revoked')).toBeTruthy();
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
    expect(await screen.findByText('installation check unavailable')).toBeTruthy();
    expect(screen.getByText(/could not verify this installation/i)).toBeTruthy();
  });

  it('identifies connected traffic without a runtime label', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      status: { ...connected, runtime: undefined },
    });
    render(<App />);
    expect(await screen.findByText('SDK connected')).toBeTruthy();
    expect(screen.getByText('endpoint summaries are arriving.')).toBeTruthy();
  });

  it('shows an actionable API failure without hiding the app shell', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ fail: true });
    render(<App />);
    expect(await screen.findByText('can’t refresh endpoint data')).toBeTruthy();
    expect(screen.getByText('endpoint count unavailable')).toBeTruthy();
    expect(screen.queryByText(/^0 observed/)).toBeNull();
    expect(screen.getByText(/application is unaffected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'try again' })).toBeTruthy();
  });

  it('keeps a fresh-window endpoint count unknown on failure and restores it after recovery', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({ endpointFailWindow: '24h' });
    render(<App />);

    expect(
      await screen.findByText('2 observed · measurements update after each complete minute'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    expect(await screen.findByText('can’t refresh endpoint data')).toBeTruthy();
    expect(screen.getByText('endpoint count unavailable')).toBeTruthy();
    expect(screen.queryByText(/^0 observed/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '1h' }));
    expect(
      await screen.findByText('2 observed · measurements update after each complete minute'),
    ).toBeTruthy();
    expect(screen.queryByText('endpoint count unavailable')).toBeNull();
    expect(screen.queryByText('can’t refresh endpoint data')).toBeNull();
  });

  it('shows a recoverable capability error instead of setup when status is unavailable', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    const fetchMock = installFetch({ capabilityFail: true });
    render(<App />);

    expect(await screen.findByText('capability status is unavailable')).toBeTruthy();
    expect(screen.queryByText(/waiting for the first valid/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'try again' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => input instanceof URL && input.pathname === '/v1/capabilities',
        ).length,
      ).toBeGreaterThan(1);
    });
  });

  it('enables a hidden capability before opening its setup', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    const fetchMock = installFetch({
      capabilityRows: (['analytics', 'endpoints', 'logs'] as const).map((id) => ({
        id,
        enabled: false,
        first_received_at: null,
        last_received_at: null,
      })),
    });
    render(<App />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'open setup' }))[0]);
    expect(await screen.findByText('install web analytics')).toBeTruthy();
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        input instanceof URL && input.pathname === '/v1/capabilities' && init?.method === 'PUT',
    );
    expect(JSON.parse(String(saveCall?.[1]?.body)).enabled).toEqual(['analytics']);
    expect(location.hash).toBe('#analytics');
  });

  it('keeps every product tool visible when capabilities are disabled', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch({
      capabilityRows: (['analytics', 'endpoints', 'logs'] as const).map((id) => ({
        id,
        enabled: false,
        first_received_at: null,
        last_received_at: null,
      })),
    });
    render(<App />);

    expect(await screen.findByRole('tab', { name: 'analytics' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'events' })).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'backend' }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByText('API monitoring is not selected')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'enable API monitoring' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'logs' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'diagnostics' })).toBeTruthy();
  });

  it('keeps capability settings open and explains a failed enable request', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch({
      capabilitySaveFail: true,
      capabilityRows: (['analytics', 'endpoints', 'logs'] as const).map((id) => ({
        id,
        enabled: false,
        first_received_at: null,
        last_received_at: null,
      })),
    });
    render(<App />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'open setup' }))[0]);
    expect(await screen.findByText('API returned 503')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'settings' })).toBeTruthy();
    expect(location.hash).toBe('#settings');
  });

  it('keeps a newly-created environment key visible without switching environments', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch();
    render(<App />);

    fireEvent.change(await screen.findByLabelText('New environment name'), {
      target: { value: 'staging' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'add environment' }));
    expect(await screen.findByText('save the private key for staging')).toBeTruthy();
    expect(screen.getByText('ahk_staging_one_time')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('production');
    expect(localStorage.getItem(STORAGE_KEY)).toContain('env-test');
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('ahk_staging_one_time');
  });

  it.each([
    [{ environmentCreateFail: true }, 'API returned 503'],
    [{ environmentCreateInvalid: true }, 'the environment response was invalid'],
  ] as const)('retains environment input after rejected creation %j', async (options, message) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch(options);
    render(<App />);
    const input = await screen.findByLabelText('New environment name');
    fireEvent.change(input, { target: { value: 'staging' } });
    fireEvent.click(screen.getByRole('button', { name: 'add environment' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(input).toHaveValue('staging');
    expect(screen.queryByText('save the private key for staging')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('production');
  });

  it.each([null, { id: 'legacy-key', environment_id: null, created_at: 1, revoked_at: null }])(
    'creates a scoped key without treating missing or legacy keys as scoped rotation',
    async (privateKey) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
      window.history.replaceState({}, '', '/app#settings');
      installFetch({ privateKey });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'create environment key' }));
      expect(await screen.findByText('ahk_environment_one_time')).toBeTruthy();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      fireEvent.click(screen.getByRole('button', { name: 'copy private key' }));
      expect(await screen.findByRole('button', { name: 'copied' })).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith('ahk_environment_one_time');
      writeText.mockRejectedValue(new Error('Copy denied'));
      fireEvent.click(screen.getByRole('button', { name: 'copied' }));
      expect(await screen.findByText('automatic copy unavailable')).toBeTruthy();
      expect(screen.getByText('ahk_environment_one_time')).toBeTruthy();
    },
  );

  it('rejects a malformed private-key response without revealing a key', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch({ privateKey: null, keyIssueInvalid: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'create environment key' }));
    expect(await screen.findByText('the key response was invalid')).toBeTruthy();
    expect(screen.queryByText('ahk_environment_one_time')).toBeNull();
  });

  it('rotates an environment private key only after confirmation', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'replace environment key' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'replace the key for checkout-api / production?',
    );
    fireEvent.click(screen.getByRole('button', { name: 'replace key' }));
    expect(await screen.findByText('ahk_environment_one_time')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'replace environment key' })).toHaveFocus(),
    );
  });

  it('keeps a failed key rotation error and retry action inside the dialog', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#settings');
    installFetch({ keyIssueFail: true });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'replace environment key' }));
    fireEvent.click(screen.getByRole('button', { name: 'replace key' }));
    const dialog = screen.getByRole('alertdialog');
    expect(await screen.findByRole('alert')).toHaveTextContent('API returned 503');
    expect(dialog).toContainElement(screen.getByRole('alert'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'replace key' })).toHaveFocus());
  });

  it('normalizes an obsolete dashboard route without preserving an alias', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    window.history.replaceState({}, '', '/app#logs');
    installFetch();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: 'analytics' })).toBeTruthy();
    expect(location.hash).toBe('#analytics');
    expect(screen.queryByRole('tablist', { name: 'Backend sections' })).toBeNull();
  });

  it('synchronizes the dashboard when the URL hash changes', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedProject));
    installFetch();
    render(<App />);
    await screen.findAllByText('/orders');

    act(() => {
      window.history.replaceState({}, '', '/app#backend/logs');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('application logs')).toBeTruthy();
    expect(document.title).toBe('backend — App Health');
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
    window.history.replaceState({}, '', '/app#backend');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('explains restricted logs to viewers without issuing a forbidden logs request', async () => {
    const mock = installFetch({ logRows, workspaceRole: 'viewer' });
    updateWorkspaceRole('viewer', workspaceScope().epoch);
    try {
      render(<App />);
      await screen.findAllByText('/orders');
      fireEvent.click(screen.getByRole('tab', { name: 'logs' }));
      expect(
        await screen.findByText('Application logs require editor or owner access.'),
      ).toBeVisible();
      expect(
        mock.mock.calls.some(
          ([input]) => new URL(String(input), location.origin).pathname === '/v1/logs',
        ),
      ).toBe(false);
    } finally {
      act(() => updateWorkspaceRole('owner', workspaceScope().epoch));
    }
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

    fireEvent.click(screen.getByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(screen.getByText('payment.failed')).toBeTruthy();
    expect(screen.getByText('card declined')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Time window' })).toBeNull();
    const firstCall = logCalls()[0][0] as URL;
    expect(firstCall.searchParams.get('app_id')).toBe('app-test');
    expect(firstCall.searchParams.get('level')).toBe('debug');

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Minimum level' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(await screen.findByRole('option', { name: 'warn and above' }));
    await waitFor(() => expect(screen.queryByText('ada@example.com')).toBeNull());
    expect(screen.getByText('payment.failed')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Minimum level' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(await screen.findByRole('option', { name: 'all levels' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Event name' }), {
      target: { value: 'signup' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'apply' }));
    await waitFor(() => expect(screen.queryByText('payment.failed')).toBeNull());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    const lastCall = logCalls().at(-1)?.[0] as URL;
    expect(lastCall.searchParams.get('event')).toBe('signup');

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
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
    fireEvent.click(await screen.findByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('payment.failed')).toBeTruthy();
    expect(screen.getByText('browser')).toBeTruthy();

    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Source' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(await screen.findByRole('option', { name: 'server only' }));
    await waitFor(() => expect(screen.queryByText('payment.failed')).toBeNull());
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    const sourceCall = fetchMock.mock.calls
      .map(([input]) => input)
      .filter((input): input is URL => input instanceof URL && input.pathname === '/v1/logs')
      .at(-1);
    expect(sourceCall?.searchParams.get('source')).toBe('server');

    expect(await screen.findByText('browser logging keys (1 active)')).toBeTruthy();
    expect(screen.getByText('https://karte.app')).toBeTruthy();
    expect(screen.queryByText('https://other.app')).toBeNull();

    fireEvent.change(screen.getByRole('textbox', { name: 'Allowed origins' }), {
      target: { value: 'https://new.app/, http://localhost:5173' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'create browser key' }));
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

    const revokeTrigger = screen.getByRole('button', {
      name: 'Revoke browser key pubkey-existing',
    });
    fireEvent.click(revokeTrigger);
    expect(screen.getByText('revoke this browser key?')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('revoke this browser key?')).toBeNull());
    expect(revokeTrigger).toHaveFocus();

    fireEvent.click(revokeTrigger);
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(screen.queryByText('revoke this browser key?')).toBeNull());
    expect(revokeTrigger).toHaveFocus();

    fireEvent.click(revokeTrigger);
    fireEvent.click(screen.getByRole('button', { name: 'revoke key' }));
    expect(await screen.findByText(/revoked/)).toBeTruthy();
  });

  it('reports browser key API failures without hiding the logs', async () => {
    installFetch({ logRows, publicKeyFail: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('ada@example.com')).toBeTruthy();
    expect(await screen.findByText('API returned 503')).toBeTruthy();
  });

  it('shows the empty state with a next action and recovers from an API failure', async () => {
    installFetch({ logRows: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('no logs match')).toBeTruthy();
    expect(screen.getByText(/POST/)).toBeTruthy();
  });

  it('keeps the shell usable when logs cannot load', async () => {
    installFetch({ logFail: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('logs are unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'try again' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'backend' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'API monitoring' })).toBeTruthy();
  });

  it('rejects malformed log responses instead of showing an empty feed', async () => {
    installFetch();
    const delegate = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/v1/logs?'))
          return Promise.resolve(Response.json({ logs: 'invalid' }));
        return delegate(input, init);
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: 'logs' }));
    expect(await screen.findByText('logs are unavailable')).toBeTruthy();
    expect(screen.queryByText('no logs match')).toBeNull();
  });

  it('shows capability-specific browser and Cloudflare Worker log setup', async () => {
    window.history.replaceState({}, '', '/app#backend/logs');
    installFetch({
      capabilityRows: [
        { id: 'analytics', enabled: false, first_received_at: null, last_received_at: null },
        { id: 'endpoints', enabled: false, first_received_at: null, last_received_at: null },
        { id: 'logs', enabled: true, first_received_at: null, last_received_at: null },
      ],
    });
    render(<App />);

    expect(await screen.findByText('send browser logs')).toBeTruthy();
    expect(screen.getByText(/Cloudflare worker · Hono/i)).toBeTruthy();
    expect(screen.getByText(/appHealth\.log\('worker\.request_failed'/)).toBeTruthy();
    expect(screen.getByText(/ctx\.waitUntil\(appHealth\.flush\(\)\)/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Allowed origins' }), {
      target: { value: 'https://product.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'create browser key' }));
    expect(await screen.findByText(/createWebLogger/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${window.location.origin}/v1/logs`))).toBeTruthy();
    expect(screen.queryByText(/window\.apphealth\.track/)).toBeNull();
  });

  it('uses product-event language when the shared browser tracker has no data yet', async () => {
    window.history.replaceState({}, '', '/app#events');
    installFetch({
      capabilityRows: [
        { id: 'analytics', enabled: true, first_received_at: null, last_received_at: null },
        { id: 'endpoints', enabled: false, first_received_at: null, last_received_at: null },
        { id: 'logs', enabled: false, first_received_at: null, last_received_at: null },
      ],
    });
    render(<App />);

    expect(await screen.findByText('install product events')).toBeTruthy();
    expect(screen.getByText(/waiting for the first valid product events event/)).toBeTruthy();
    expect(screen.queryByText('install web analytics')).toBeNull();
    expect(screen.getByRole('button', { name: /^explore revenue$/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /^explore conversions$/ })).toBeVisible();
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
