import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectsView } from '../src/ProjectsView.js';

const now = 1_800_000_000_000;
const projects = [
  { appId: 'one', environmentId: 'prod', name: 'Atlas', environment: 'production' },
  { appId: 'one', environmentId: 'staging', name: 'Atlas', environment: 'staging' },
  { appId: 'two', environmentId: 'prod', name: 'Beacon', environment: 'production' },
];

const summary = {
  enabled: true,
  source: 'local',
  sampled: false,
  stream: false,
  projects: [
    { app_id: 'one', environment_id: 'prod', pageviews: 120, events: 14, sessions: 8 },
    { app_id: 'one', environment_id: 'staging', pageviews: 4, events: 1, sessions: 2 },
  ],
  live: { measured_at: now, ttl_ms: 45000, total: 0, projects: [] },
};

const health = {
  refreshed_at: now,
  window_end: now,
  window: '24h',
  environments: [
    {
      app_id: 'one',
      app_name: 'Atlas',
      environment_id: 'prod',
      environment_name: 'production',
      analytics: { enabled: true, first_received_at: now - 10_000, last_received_at: now - 5_000 },
      endpoints: {
        state: 'connected',
        runtime: 'worker',
        first_received_at: now - 100_000,
        last_received_at: now - 60_000,
        metrics: {
          request_count: 100,
          error_count: 0,
          error_rate: 0,
          p95_ms: 2500,
          last_seen: now - 60_000,
          health_state: 'unhealthy',
        },
      },
    },
    {
      app_id: 'one',
      app_name: 'Atlas',
      environment_id: 'staging',
      environment_name: 'staging',
      analytics: { enabled: true, first_received_at: now - 10_000, last_received_at: now - 5_000 },
      endpoints: {
        state: 'unconfigured',
        runtime: null,
        first_received_at: null,
        last_received_at: null,
        metrics: null,
      },
    },
    {
      app_id: 'two',
      app_name: 'Beacon',
      environment_id: 'prod',
      environment_name: 'production',
      analytics: { enabled: false, first_received_at: null, last_received_at: null },
      endpoints: {
        state: 'connected',
        runtime: 'go',
        first_received_at: now - 100_000,
        last_received_at: now - 60_000,
        metrics: {
          request_count: 50,
          error_count: 0,
          error_rate: 0,
          p95_ms: 100,
          last_seen: now - 60_000,
          health_state: 'healthy',
        },
      },
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installFetch(options?: { healthResponse?: Response; reportResponse?: Response }) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/v1/workspace/health'))
      return options?.healthResponse ?? Response.json(health);
    if (path.includes('/v1/workspace/alerts'))
      return Response.json({ generated_at: now, total_count: 0, entries: [] });
    if (path.includes('/v1/reports/daily-engagement'))
      return options?.reportResponse ?? Response.json(summary);
    return Response.json(summary);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

it('uses catalog server applicability without hiding measured or out-of-report endpoints', async () => {
  const endpointHealth = structuredClone(health);
  endpointHealth.environments[2].endpoints = structuredClone(
    endpointHealth.environments[1].endpoints,
  );
  endpointHealth.environments.push({
    ...structuredClone(endpointHealth.environments[1]),
    app_id: 'outside',
    app_name: 'Outside',
    environment_id: 'prod',
    environment_name: 'production',
  });
  const reportProduct = (appId: string, applicability: 'applicable' | 'not_applicable') => ({
    catalog_id: appId,
    app_id: appId,
    name: appId,
    browser_visitors: null,
    cta_events: [],
    cta_status: 'unknown',
    feedback_submitted: null,
    newsletter_joins: null,
    waitlist_joins: null,
    native_sessions: null,
    api_activity: null,
    server_requests_applicability: applicability,
    freshness: { browser_last_seen: null, log_last_seen: null },
    coverage: 'unknown',
  });
  const report = {
    schema: 'app-health.daily-engagement.v1',
    schema_version: 1,
    generated_at: now,
    date: '2026-09-28',
    timezone: 'Asia/Kolkata',
    from: now - 86_400_000,
    to: now,
    product_count: 2,
    products: [reportProduct('one', 'applicable'), reportProduct('two', 'not_applicable')],
    sampled: false,
    notes: [],
  };
  installFetch({
    healthResponse: Response.json(endpointHealth),
    reportResponse: Response.json(report),
  });
  render(
    <ProjectsView
      projects={[
        ...projects,
        { appId: 'outside', environmentId: 'prod', name: 'Outside', environment: 'production' },
      ]}
      ownerToken="owner"
      onOpen={() => {}}
    />,
  );

  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  await waitFor(() =>
    expect(
      within(inventory).getByText(
        /4 workspace environments · 1 connected · 0 waiting for data · 2 unconfigured · 1 not applicable/,
      ),
    ).toBeTruthy(),
  );
  const beacon = within(inventory).getByText('Beacon').closest('tr')!;
  expect(within(beacon).getAllByText('Not applicable')).toHaveLength(2);
  const outside = within(inventory).getByText('Outside').closest('tr')!;
  expect(within(outside).getByText('Not configured')).toBeTruthy();
  expect(within(outside).getByText('Never received')).toBeTruthy();
  const atlas = within(inventory).getAllByText('Atlas')[0].closest('tr')!;
  expect(within(atlas).getByText('Unhealthy')).toBeTruthy();
});

it('scopes briefing health coverage to the daily report and keeps extra workspace issues visible', async () => {
  const reportProducts = Array.from({ length: 55 }, (_, index) => ({
    catalog_id: `catalog-${index}`,
    app_id: `app-${index}`,
    name: `Product ${index}`,
    browser_visitors: null,
    browser_visitors_applicability: 'unknown',
    cta_events: [],
    cta_status: 'unknown',
    feedback_submitted: null,
    newsletter_joins: null,
    newsletter_applicability: 'unknown',
    waitlist_joins: null,
    waitlist_applicability: 'unknown',
    native_sessions: null,
    native_sessions_applicability: 'unknown',
    api_activity: null,
    server_requests_applicability: index < 50 ? 'applicable' : 'not_applicable',
    freshness: { browser_last_seen: null, log_last_seen: null },
    coverage: 'unknown',
  }));
  const report = {
    schema: 'app-health.daily-engagement.v1',
    schema_version: 1,
    generated_at: now,
    date: '2026-09-28',
    timezone: 'Asia/Kolkata',
    from: now - 86_400_000,
    to: now,
    product_count: reportProducts.length,
    products: reportProducts,
    sampled: false,
    notes: [],
  };
  const inventory = [
    ...reportProducts,
    {
      ...reportProducts[0],
      app_id: 'workspace-extra',
      catalog_id: 'workspace-extra',
      name: 'Workspace extra',
    },
  ];
  const measuredEnvironment = (
    appId: string,
    name: string,
    state: 'healthy' | 'unhealthy' | null,
  ) => ({
    app_id: appId,
    app_name: name,
    environment_id: `prod-${appId}`,
    environment_name: 'production',
    analytics: { enabled: false, first_received_at: null, last_received_at: null },
    endpoints: {
      state:
        state === null
          ? appId.startsWith('app-') && Number(appId.slice(4)) >= 50
            ? 'unconfigured'
            : 'connected'
          : 'connected',
      runtime: 'worker',
      first_received_at: state === null ? null : now - 100_000,
      last_received_at: state === null ? null : now - 60_000,
      metrics:
        state === null
          ? null
          : {
              request_count: 100,
              error_count: state === 'unhealthy' ? 40 : 0,
              error_rate: state === 'unhealthy' ? 0.4 : 0,
              p95_ms: state === 'unhealthy' ? 2_500 : 100,
              last_seen: now - 60_000,
              health_state: state,
            },
    },
  });
  const healthResponse = {
    ...health,
    environments: [
      ...inventory.map((product, index) =>
        measuredEnvironment(
          product.app_id,
          product.name,
          index < 12 || index === 50 || index === 55 ? 'unhealthy' : index < 16 ? 'healthy' : null,
        ),
      ),
    ],
  };
  installFetch({
    healthResponse: Response.json(healthResponse),
    reportResponse: Response.json(report),
  });
  render(
    <ProjectsView
      projects={inventory.map((product) => ({
        appId: product.app_id,
        environmentId: `prod-${product.app_id}`,
        name: product.name,
        environment: 'production',
      }))}
      ownerToken="owner"
      onOpen={() => {}}
    />,
  );

  const summaryRegion = await screen.findByRole('region', { name: 'Selected day summary' });
  const healthStat = within(summaryRegion).getByText('Measured health issues').parentElement!;
  await waitFor(() => expect(healthStat.textContent).toContain('13'));
  expect(healthStat.textContent).toContain(
    '17/51 applicable measured · 55 report products · latest 24 hours · 1 issue outside report scope',
  );
  expect(screen.getByText('Product 0: High 5xx and slow requests')).toBeTruthy();
  expect(screen.getByText('Product 50: High 5xx and slow requests')).toBeTruthy();

  fireEvent.click(screen.getByText('Request health and collection details'));
  const issues = screen
    .getByText('Request issues', { selector: '[data-slot="card-title"]' })
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(issues).getByText('Workspace extra')).toBeTruthy();
});

it('leads with the daily report, keeps alerts nearby, and follows with request health and inventory', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="owner" onOpen={() => {}} />);

  const daily = await screen.findByRole('heading', {
    name: /Monday, 28 Sept 2026/,
  });
  const alerts = screen.getByText('Feedback and consented joins · separate from the selected day', {
    selector: '[data-slot="card-title"]',
  });
  fireEvent.click(screen.getByText('Request health and collection details'));
  const requestHealth = screen.getByRole('heading', { name: 'Request health' });
  const issues = screen.getByText('Request issues', { selector: '[data-slot="card-title"]' });
  const inventory = screen.getByText('Complete inventory', {
    selector: '[data-slot="card-title"]',
  });
  const precedes = (first: HTMLElement, second: HTMLElement) =>
    Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

  expect(precedes(daily, alerts)).toBe(true);
  expect(precedes(alerts, requestHealth)).toBe(true);
  expect(precedes(requestHealth, issues)).toBe(true);
  expect(precedes(issues, inventory)).toBe(true);
});

it('keeps slow measured requests separate from unconfigured inventory', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="owner" onOpen={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'Request health' })).toBeTruthy();
  expect(screen.getByText(/p95 histogram upper bound against 5xx rate/)).toBeTruthy();
  const queue = screen
    .getByText('Request issues', { selector: '[data-slot="card-title"]' })
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(queue).getByText(/Slow requests/)).toBeTruthy();
  expect(within(queue).queryByText(/Endpoint monitoring not configured/)).toBeNull();
  expect(within(queue).queryByText('Beacon')).toBeNull();
  const issues = screen
    .getByText('Request issues', { selector: 'p' })
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(issues).getByText('1')).toBeTruthy();
  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(inventory).getAllByText('Atlas')).toHaveLength(2);
  expect(within(inventory).getByText('Beacon')).toBeTruthy();
  expect(within(inventory).getByText('120')).toBeTruthy();
  expect(within(inventory).getByText('100 requests')).toBeTruthy();
  expect(
    within(inventory).getByText(
      /3 workspace environments · 2 connected · 0 waiting for data · 1 unconfigured/,
    ),
  ).toBeTruthy();
  expect(within(inventory).getByText(/Products without a server endpoint/)).toBeTruthy();
  expect(screen.getByText(/Requests are server or function calls/)).toBeTruthy();
});

it('keeps legacy latency uncertainty out of the measured issue queue', async () => {
  const uncertainHealth = structuredClone(health);
  uncertainHealth.environments[0].endpoints.metrics!.health_state = 'insufficient-data';
  installFetch({ healthResponse: Response.json(uncertainHealth) });
  render(<ProjectsView projects={projects} ownerToken="owner" onOpen={() => {}} />);
  await screen.findByText('No measured request issues in the current inventory.');
  const queue = screen
    .getByText('Request issues', { selector: '[data-slot="card-title"]' })
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(
    within(queue).getByText('No measured request issues in the current inventory.'),
  ).toBeTruthy();
  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(inventory).getByText('Latency uncertain')).toBeTruthy();
  expect(within(inventory).getByText('100 requests')).toBeTruthy();
});

it('shows exact freshness and never turns missing measurements into zero', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="" onOpen={() => {}} />);
  await screen.findByText('Complete inventory');
  expect(screen.getAllByText('Never received').length).toBeGreaterThan(0);
  expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  expect(
    document.querySelector(`time[dateTime="${new Date(now - 60_000).toISOString()}"]`),
  ).toBeTruthy();
});

it('searches and filters the complete inventory', async () => {
  installFetch();
  render(<ProjectsView projects={projects} ownerToken="" onOpen={() => {}} />);
  const search = await screen.findByRole('textbox', { name: 'Search inventory' });
  fireEvent.change(search, { target: { value: 'Beacon' } });
  const inventory = screen
    .getByText('Complete inventory')
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(inventory).getByText('Beacon')).toBeTruthy();
  expect(within(inventory).queryByText('Atlas')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Request issues only' }));
  expect(within(inventory).getByText('No environments match this view.')).toBeTruthy();
});

it('opens the selected environment from the inventory', async () => {
  installFetch();
  const onOpen = vi.fn();
  render(<ProjectsView projects={[projects[2]]} ownerToken="" onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole('button', { name: /Open/ }));
  expect(onOpen).toHaveBeenCalledWith(projects[2]);
});

it('keeps partial data visible and retries both workspace feeds', async () => {
  const fetch = installFetch({ healthResponse: new Response(null, { status: 503 }) });
  render(<ProjectsView projects={[projects[0]]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Some Watchtower data could not refresh',
  );
  expect(screen.getByText('120')).toBeTruthy();
  expect(
    screen.getByText('Request health is unavailable. Retry to check for issues.'),
  ).toBeTruthy();
  const issues = screen
    .getByText('Request issues', { selector: 'p' })
    .closest<HTMLElement>('[data-slot="card"]')!;
  expect(within(issues).getByText('—')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(4));
});

it('explains the empty workspace state', async () => {
  installFetch();
  render(<ProjectsView projects={[]} ownerToken="" onOpen={() => {}} />);
  expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
});
