import { afterEach, expect, it, vi } from 'vitest';
import {
  createPortfolioUsageExport,
  type PortfolioUsageCatalogProduct,
  type PortfolioUsageProject,
} from '../src/lib/portfolio-usage-export.js';

afterEach(() => {
  vi.useRealTimers();
});

function browserReport(from = Date.UTC(2026, 8, 24), to = Date.UTC(2026, 9, 24)) {
  return {
    from,
    to,
    sampled: false,
    source: 'analytics-engine',
    series: [],
    pages: [],
    sources: [],
    events: [
      { name: 'workspace.opened', count: 3, last_seen: Date.UTC(2026, 9, 23) },
      { name: '/raw/path?private=1', count: 1, last_seen: Date.UTC(2026, 9, 23) },
    ],
    sessions: 0,
    audience: {
      visitors: 0,
      new_sessions: 0,
      returning_sessions: 0,
      unidentified_sessions: 0,
      channels: [],
      campaigns: [],
      devices: [],
      browsers: [],
      countries: [],
      entry_pages: [],
    },
  };
}

const products: PortfolioUsageCatalogProduct[] = [
  {
    catalog_id: 'atlas',
    app_id: 'app-atlas',
    name: 'Atlas',
    browser_visitors_applicability: 'applicable',
    coverage: 'full',
  },
  {
    catalog_id: 'beacon',
    app_id: 'app-beacon',
    name: 'Beacon',
    browser_visitors_applicability: 'unknown',
    coverage: 'unknown',
  },
  {
    catalog_id: 'disabled',
    app_id: 'app-disabled',
    name: 'Disabled',
    browser_visitors_applicability: 'not_applicable',
    coverage: 'unknown',
  },
];

const projects: PortfolioUsageProject[] = [
  {
    appId: 'app-atlas',
    environmentId: 'env-atlas-prod',
    name: 'Atlas',
    environment: 'production',
  },
  {
    appId: 'app-atlas',
    environmentId: 'env-atlas-dev',
    name: 'Atlas',
    environment: 'development',
  },
  {
    appId: 'app-disabled',
    environmentId: 'env-disabled-prod',
    name: 'Disabled',
    environment: 'production',
  },
];

it('exports allowlisted rolling aggregates, keeps core use unknown, and falls back to sessions', async () => {
  const response = browserReport();
  response.audience.visitors = 5;
  response.sessions = 5;
  response.sampled = true;
  response.events[0].count = 3.5;
  const fetcher = vi.fn(async () => Response.json(response));
  const controller = new AbortController();
  const result = await createPortfolioUsageExport({
    ownerToken: 'owner-token',
    products: products.slice(0, 1),
    projects,
    signal: controller.signal,
    now: () => Date.UTC(2026, 9, 24),
    fetcher: fetcher as typeof fetch,
  });

  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('range=30d');
  expect(url).toContain('app_id=app-atlas');
  expect(url).toContain('environment_id=env-atlas-prod');
  expect(url).not.toContain('date=');
  expect(url).not.toContain('event=');
  expect(new Headers(init.headers).has('authorization')).toBe(true);
  expect(result).toMatchObject({ kind: 'portfolio-usage', schemaVersion: 1 });
  expect(result.usage.records.atlas).toMatchObject({
    proxy: { count: 5, unit: 'browsers', precision: 'lower_bound' },
    core: {
      count: null,
      qualified: false,
      precision: 'unknown',
      coverage: 'unknown',
      lastUsedAt: null,
    },
    tracking: 'partial',
    events: [
      {
        name: 'workspace.opened',
        count: 3.5,
        precision: 'estimate',
        lastSeen: '2026-10-23T00:00:00.000Z',
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('/raw/path');
  expect(JSON.stringify(result)).not.toContain('private=1');
  expect(JSON.stringify(result.usage.records.atlas.evidence)).not.toContain('app-atlas');
  expect(result.usage.records.atlas.evidence[0].source).toBe('app-health.browser-report');
  expect(typeof result.usage.records.atlas.limitations).toBe('string');
  expect(result.usage.records.atlas.limitations).toContain(
    'audience counts do not establish human demand',
  );
});

it('keeps missing environments, disabled sources, and API failures unknown', async () => {
  const fetcher = vi.fn(async () => new Response('unavailable', { status: 503 }));
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products,
    projects,
    signal: new AbortController().signal,
    fetcher: fetcher as typeof fetch,
  });

  expect(result.usage.records.atlas.proxy).toEqual({
    count: null,
    unit: 'browsers',
    precision: 'unknown',
  });
  expect(result.usage.records.atlas.tracking).toBe('missing');
  expect(result.usage.records.beacon.proxy.count).toBeNull();
  expect(result.usage.records.beacon.evidence[0].note).toContain('No production environment');
  expect(result.usage.records.disabled.proxy.count).toBeNull();
  expect(result.usage.records.disabled.evidence[0].note).toContain('not applicable');
  expect(
    new Date(result.usage.records.disabled.windowEnd).getTime() -
      new Date(result.usage.records.disabled.windowStart).getTime(),
  ).toBe(30 * 24 * 60 * 60 * 1_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('uses a session proxy when no recognized browsers are reported and caps concurrency', async () => {
  let active = 0;
  let maximumActive = 0;
  const manyProducts = Array.from({ length: 12 }, (_, index) => ({
    catalog_id: `product-${index}`,
    app_id: `app-${index}`,
    name: `Product ${index}`,
    browser_visitors_applicability: 'applicable' as const,
    coverage: 'full' as const,
  }));
  const manyProjects = manyProducts.map((product) => ({
    appId: product.app_id,
    environmentId: `env-${product.app_id}`,
    name: product.name,
    environment: 'production',
  }));
  const report = browserReport();
  report.sessions = 7;
  const fetcher: typeof fetch = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return Response.json(report);
  };
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products: manyProducts,
    projects: manyProjects,
    signal: new AbortController().signal,
    concurrency: 100,
    fetcher,
  });

  expect(maximumActive).toBeLessThanOrEqual(4);
  expect(result.usage.records['product-0'].proxy).toEqual({
    count: 7,
    unit: 'sessions',
    precision: 'exact',
  });
});

it('discards otherwise valid counts when the report window is not exact or ends in the future', async () => {
  const checkedAt = Date.UTC(2026, 9, 24);
  const valid = browserReport();
  valid.audience.visitors = 42;
  const responses = [
    { ...valid, from: valid.from + 1 },
    { ...valid, to: checkedAt + 1 },
  ];
  const fetcher: typeof fetch = async () => Response.json(responses.shift());
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products: [products[0], { ...products[0], catalog_id: 'atlas-two', app_id: 'app-atlas-two' }],
    projects: [
      ...projects,
      {
        appId: 'app-atlas-two',
        environmentId: 'env-atlas-two',
        name: 'Atlas 2',
        environment: 'production',
      },
    ],
    signal: new AbortController().signal,
    now: () => checkedAt,
    fetcher,
  });

  for (const record of Object.values(result.usage.records)) {
    expect(record.proxy).toEqual({ count: null, unit: 'browsers', precision: 'unknown' });
    expect(record.events).toBeUndefined();
    expect(record.limitations).toContain('counts were discarded');
    expect(new Date(record.windowEnd).getTime() - new Date(record.windowStart).getTime()).toBe(
      30 * 24 * 60 * 60 * 1_000,
    );
  }
});

it('omits fractional browser/session proxy counts without rounding', async () => {
  const response = browserReport();
  response.audience.visitors = 3.5;
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products: products.slice(0, 1),
    projects,
    signal: new AbortController().signal,
    fetcher: async () => Response.json(response),
  });
  expect(result.usage.records.atlas.proxy).toEqual({
    count: null,
    unit: 'browsers',
    precision: 'unknown',
  });
  expect(result.usage.records.atlas.limitations).toContain('omitted without rounding');
});

it('keeps an empty applicable report unknown when no source qualification is supplied', async () => {
  const response = browserReport();
  response.events = [];
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products: products.slice(0, 1),
    projects,
    signal: new AbortController().signal,
    fetcher: async () => Response.json(response),
  });
  expect(result.usage.records.atlas.proxy).toEqual({
    count: null,
    unit: 'browsers',
    precision: 'unknown',
  });
});

it('rejects non-canonical uppercase catalog identifiers before requests', async () => {
  const fetcher = vi.fn();
  await expect(
    createPortfolioUsageExport({
      ownerToken: '',
      products: [{ ...products[0], catalog_id: 'Atlas' }],
      projects,
      signal: new AbortController().signal,
      fetcher: fetcher as typeof fetch,
    }),
  ).rejects.toThrow('invalid catalog');
  expect(fetcher).not.toHaveBeenCalled();
});

it('cancels the export and rejects portfolios over the catalog cap', async () => {
  const controller = new AbortController();
  const fetcher = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  const task = createPortfolioUsageExport({
    ownerToken: '',
    products: products.slice(0, 1),
    projects,
    signal: controller.signal,
    fetcher: fetcher as typeof fetch,
  });
  controller.abort();
  await expect(task).rejects.toThrow();
  await expect(
    createPortfolioUsageExport({
      ownerToken: '',
      products: Array.from({ length: 56 }, (_, index) => ({
        catalog_id: `project-${index}`,
        app_id: `app-${index}`,
        name: `Project ${index}`,
        browser_visitors_applicability: 'applicable' as const,
        coverage: 'full' as const,
      })),
      projects: [],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('limited to 55');
});

it('stamps each record after its delayed report and stamps the export at completion', async () => {
  const initial = Date.UTC(2026, 9, 24);
  let now = initial;
  const fetcher: typeof fetch = async () => {
    now += 10_000;
    return Response.json(browserReport(now - 30 * 24 * 60 * 60 * 1_000, now - 1_000));
  };
  const result = await createPortfolioUsageExport({
    ownerToken: '',
    products: products.slice(0, 1),
    projects,
    signal: new AbortController().signal,
    now: () => {
      const current = now;
      now += 1_000;
      return current;
    },
    fetcher,
  });
  const record = result.usage.records.atlas;
  expect(new Date(record.checkedAt).getTime()).toBeGreaterThanOrEqual(
    new Date(record.windowEnd).getTime(),
  );
  expect(new Date(result.usage.updatedAt).getTime()).toBeGreaterThan(
    new Date(record.checkedAt).getTime(),
  );
});
