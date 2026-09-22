import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index.js';
import type { D1DatabaseLike, D1PreparedStatement, D1RunResult } from '../src/d1-adapter.js';
import {
  SEED_APP_ID,
  SEED_ENV_ID,
  SEED_KEY,
  SEED_APP_NAME,
  SEED_ENV_NAME,
  buildCanonicalBatch,
} from '@app-health/contracts';

const LOCAL_ENV: Env = { APP_HEALTH_MODE: 'local' };
const NON_LOCAL_ENV: Env = {};

async function call(
  method: string,
  path: string,
  env: Env,
  body?: unknown,
  headers?: Record<string, string>,
  origin = 'https://worker.local',
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const url = new URL(`${origin}${path}`);
  return worker.fetch(new Request(url, init), env);
}

async function callRaw(
  method: string,
  path: string,
  env: Env,
  body: BodyInit | null,
  headers: Record<string, string>,
  origin = 'https://worker.local',
): Promise<Response> {
  return worker.fetch(new Request(new URL(`${origin}${path}`), { method, body, headers }), env);
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

describe('public agent surfaces', () => {
  it('serves discovery without requiring owner or telemetry bindings', async () => {
    const llms = await call(
      'GET',
      '/llms.txt',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(llms.status).toBe(200);
    expect(llms.headers.get('content-type')).toContain('text/plain');
    expect(await llms.text()).toMatch(/^# App Health/);

    const catalog = await call(
      'GET',
      '/api/ai',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(catalog.status).toBe(200);
    expect((await catalog.json()) as { name: string }).toMatchObject({ name: 'App Health' });
  });

  it('serves the OpenAPI spec and advertises it from the catalog', async () => {
    const spec = await call(
      'GET',
      '/openapi.json',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(spec.status).toBe(200);
    expect(spec.headers.get('content-type')).toContain('application/json');
    const document = (await spec.json()) as {
      openapi: string;
      info: { title: string };
      paths: Record<string, unknown>;
    };
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('App Health public API');
    // Every surface the catalog advertises has to be described, or the spec is a lie.
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/ai',
      '/llms-full.txt',
      '/llms.txt',
      '/openapi.json',
      '/sitemap.xml',
    ]);

    const catalog = await call(
      'GET',
      '/api/ai',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect((await catalog.json()) as { openapi: string }).toMatchObject({
      openapi: 'https://health.sassmaker.com/openapi.json',
    });
  });

  it('rebinds the OpenAPI catalog link to the requesting origin', async () => {
    const catalog = await call(
      'GET',
      '/api/ai',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://app-health.pages.dev',
    );
    expect((await catalog.json()) as { openapi: string }).toMatchObject({
      openapi: 'https://app-health.pages.dev/openapi.json',
    });
  });

  it('answers unknown /api paths with JSON rather than an HTML shell', async () => {
    const response = await call(
      'GET',
      '/api/does-not-exist',
      NON_LOCAL_ENV,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()) as { error: unknown }).toEqual({
      error: {
        code: 'not_found',
        message: 'Unknown API path: /api/does-not-exist',
        path: '/api/does-not-exist',
      },
    });
  });

  it('negotiates markdown on the homepage and varies on Accept', async () => {
    const response = await call(
      'GET',
      '/',
      NON_LOCAL_ENV,
      undefined,
      { accept: 'text/markdown' },
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('vary')).toBe('Accept, Accept-Encoding');
  });

  it('serves every catalogued machine surface', async () => {
    const cases = [
      ['/llms-full.txt', 'text/plain', /^# App Health — full agent brief/],
      ['/index.md', 'text/markdown', /^# App Health/],
      ['/openapi.yaml', 'application/json', /"openapi": "3\.1\.0"/],
    ] as const;
    for (const [path, contentType, body] of cases) {
      const response = await call(
        'GET',
        path,
        NON_LOCAL_ENV,
        undefined,
        undefined,
        'https://health.sassmaker.com',
      );
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain(contentType);
      expect(await response.text(), path).toMatch(body);
    }
  });

  it('does not expose product discovery on the ingest hostname', async () => {
    const response = await call(
      'GET',
      '/llms.txt',
      productionEnv(),
      undefined,
      undefined,
      'https://ingest.sassmaker.com',
    );
    expect(response.status).toBe(404);
  });
});

class ProductionStatement implements D1PreparedStatement {
  values: unknown[] = [];
  constructor(readonly sql: string) {}
  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes('FROM keys WHERE verifier_hash')) {
      return {
        id: 'key-1',
        app_id: 'app-1',
        environment_id: null,
        verifier_hash: String(this.values[0]),
        created_at: 1,
        revoked_at: null,
      } as T;
    }
    if (this.sql.includes('FROM apps WHERE id = ?') && this.values[0] === 'app-1') {
      return {
        id: 'app-1',
        name: 'polaris',
        created_at: 1,
      } as T;
    }
    if (this.sql.includes('FROM environments WHERE app_id = ? AND name = ?')) {
      return {
        id: `env-${String(this.values[1])}`,
        app_id: 'app-1',
        name: String(this.values[1]),
        created_at: 1,
      } as T;
    }
    return null;
  }
  async all<T>() {
    if (this.sql.includes('FROM environments WHERE app_id = ?') && this.values[0] === 'app-1') {
      return {
        results: [
          { id: 'env-local', app_id: 'app-1', name: 'local', created_at: 1 },
          { id: 'env-staging', app_id: 'app-1', name: 'staging', created_at: 2 },
        ] as T[],
      };
    }
    return { results: [] as T[] };
  }
  async run(): Promise<D1RunResult> {
    // Routing-only fixture; transactional storage behavior uses real workerd/D1.
    if (this.sql.includes("SELECT DISTINCT json_extract(event, '$.id') AS id FROM unseen")) {
      const events = JSON.parse(String(this.values[0])) as { id: string }[];
      return { success: true, meta: { changes: 0 }, results: events.map(({ id }) => ({ id })) };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class ProductionDatabase implements D1DatabaseLike {
  prepare(query: string): D1PreparedStatement {
    return new ProductionStatement(query);
  }
  async batch(statements: D1PreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function productionEnv(): Env {
  return {
    DB: new ProductionDatabase(),
    TELEMETRY: { writeDataPoint() {} },
    OWNER_AUTH_TOKEN: 'aho_production-owner',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    ANALYTICS_ENGINE_QUERY_TOKEN: 'query-token',
    APP_HEALTH_DASHBOARD_HOST: 'health.sassmaker.com',
    APP_HEALTH_INGEST_HOST: 'ingest.sassmaker.com',
    APP_HEALTH_INGEST_ORIGIN: 'https://ingest.sassmaker.com',
  };
}

function currentBatch() {
  const now = Date.now();
  const batch = buildCanonicalBatch('node');
  return {
    ...batch,
    events: batch.events.map((event, index) => ({ ...event, timestamp: now + index })),
  };
}

function otlpJson(now = Date.now()): string {
  const end = BigInt(now) * 1_000_000n;
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.version', value: { stringValue: 'release-otel' } },
            {
              key: 'deployment.environment.name',
              value: { stringValue: 'production' },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: '000102030405060708090a0b0c0d0e0f',
                spanId: '1011121314151617',
                kind: 2,
                startTimeUnixNano: String(end - 25_000_000n),
                endTimeUnixNano: String(end),
                attributes: [
                  { key: 'http.request.method', value: { stringValue: 'GET' } },
                  { key: 'http.route', value: { stringValue: '/otel/:id' } },
                  { key: 'http.response.status_code', value: { intValue: '200' } },
                  { key: 'url.path', value: { stringValue: '/otel/alice-private' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

async function gzip(value: string): Promise<Uint8Array> {
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('worker /v1/health', () => {
  it('returns ok regardless of mode', async () => {
    const res = await call('GET', '/v1/health', NON_LOCAL_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('worker owner APIs fail closed outside local mode', () => {
  it('rejects /v1/apps outside local mode', async () => {
    const res = await call('POST', '/v1/apps', NON_LOCAL_ENV, {
      name: 'x',
      environment: 'prod',
    });
    expect(res.status).toBe(503);
  });

  it('rejects /v1/endpoints outside local mode', async () => {
    const res = await call(
      'GET',
      `/v1/endpoints?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&window=15m`,
      NON_LOCAL_ENV,
    );
    expect(res.status).toBe(503);
  });

  it('rejects /v1/installation/status outside local mode', async () => {
    const res = await call(
      'GET',
      `/v1/installation/status?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}`,
      NON_LOCAL_ENV,
    );
    expect(res.status).toBe(503);
  });

  it('rejects /v1/failures outside local mode', async () => {
    const res = await call(
      'GET',
      `/v1/failures?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}`,
      NON_LOCAL_ENV,
    );
    expect(res.status).toBe(503);
  });

  it('rejects ingest outside local mode', async () => {
    const res = await call(
      'POST',
      '/v1/ingest',
      NON_LOCAL_ENV,
      buildCanonicalBatch('node'),
      bearer(SEED_KEY),
    );
    expect(res.status).toBe(503);
  });
});

describe('worker production boundaries', () => {
  it('allows bearer-key ingest on only the ingest hostname without owner credentials', async () => {
    const response = await call(
      'POST',
      '/v1/ingest',
      productionEnv(),
      currentBatch(),
      bearer('ahk_production'),
      'https://ingest.sassmaker.com',
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: 6, duplicates: 0 });
  });

  it('accepts authenticated OTLP JSON on only the ingest hostname', async () => {
    const headers = { ...bearer('ahk_production'), 'content-type': 'application/json' };
    const response = await callRaw(
      'POST',
      '/v1/traces',
      productionEnv(),
      otlpJson(),
      headers,
      'https://ingest.sassmaker.com',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({});

    const wrongHost = await callRaw(
      'POST',
      '/v1/traces',
      productionEnv(),
      otlpJson(),
      headers,
      'https://health.sassmaker.com',
    );
    expect(wrongHost.status).toBe(404);
  });

  it('enforces OTLP method, content type, encoding, and bearer authentication', async () => {
    const env = productionEnv();
    const origin = 'https://ingest.sassmaker.com';
    await expect(
      callRaw('GET', '/v1/traces', env, null, bearer('ahk_production'), origin).then(
        (response) => response.status,
      ),
    ).resolves.toBe(405);
    await expect(
      callRaw(
        'POST',
        '/v1/traces',
        env,
        otlpJson(),
        { ...bearer('ahk_production'), 'content-type': 'text/plain' },
        origin,
      ).then((response) => response.status),
    ).resolves.toBe(415);
    await expect(
      callRaw(
        'POST',
        '/v1/traces',
        env,
        otlpJson(),
        { 'content-type': 'application/json' },
        origin,
      ).then((response) => response.status),
    ).resolves.toBe(401);
    await expect(
      callRaw(
        'POST',
        '/v1/traces',
        env,
        otlpJson(),
        {
          ...bearer('ahk_production'),
          'content-type': 'application/json',
          'content-encoding': 'br',
        },
        origin,
      ).then((response) => response.status),
    ).resolves.toBe(415);
  });

  it('supports gzip and bounds the decompressed OTLP body', async () => {
    const env = productionEnv();
    const headers = {
      ...bearer('ahk_production'),
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    };
    const accepted = await callRaw(
      'POST',
      '/v1/traces',
      env,
      await gzip(otlpJson()),
      headers,
      'https://ingest.sassmaker.com',
    );
    expect(accepted.status).toBe(200);

    const oversized = await callRaw(
      'POST',
      '/v1/traces',
      env,
      await gzip(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) })),
      headers,
      'https://ingest.sassmaker.com',
    );
    expect(oversized.status).toBe(413);
  });

  it('rejects malformed OTLP JSON and protobuf without storing telemetry', async () => {
    const env = productionEnv();
    const origin = 'https://ingest.sassmaker.com';
    const auth = bearer('ahk_production');
    await expect(
      callRaw(
        'POST',
        '/v1/traces',
        env,
        '{',
        { ...auth, 'content-type': 'application/json' },
        origin,
      ).then((response) => response.status),
    ).resolves.toBe(400);
    await expect(
      callRaw(
        'POST',
        '/v1/traces',
        env,
        Uint8Array.of(0xff),
        { ...auth, 'content-type': 'application/x-protobuf' },
        origin,
      ).then((response) => response.status),
    ).resolves.toBe(400);
  });

  it('rejects workers.dev and cross-host route bypasses', async () => {
    const env = productionEnv();
    await expect(
      call(
        'POST',
        '/v1/ingest',
        env,
        currentBatch(),
        bearer('ahk_production'),
        'https://app-health-worker.example.workers.dev',
      ).then((response) => response.status),
    ).resolves.toBe(404);
    await expect(
      call('GET', '/v1/apps', env, undefined, undefined, 'https://ingest.sassmaker.com').then(
        (response) => response.status,
      ),
    ).resolves.toBe(404);
    await expect(
      call(
        'POST',
        '/v1/ingest',
        env,
        currentBatch(),
        bearer('ahk_production'),
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(404);
  });

  it('requires the owner secret for owner APIs', async () => {
    const response = await call(
      'GET',
      '/v1/apps',
      productionEnv(),
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts the owner secret for owner APIs', async () => {
    const response = await call(
      'GET',
      '/v1/apps',
      productionEnv(),
      undefined,
      bearer('aho_production-owner'),
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(200);
  });

  it('uses a product key to list only its product and environments', async () => {
    const response = await call(
      'GET',
      '/v1/apps',
      productionEnv(),
      undefined,
      bearer('ahk_polaris-product'),
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      apps: [
        {
          app: { id: 'app-1', name: 'polaris', created_at: 1 },
          environments: [
            { id: 'env-local', app_id: 'app-1', name: 'local', created_at: 1 },
            { id: 'env-staging', app_id: 'app-1', name: 'staging', created_at: 2 },
          ],
        },
      ],
    });
  });

  it('forbids product-scoped keys from reading workspace health', async () => {
    const response = await call(
      'GET',
      '/v1/workspace/health',
      productionEnv(),
      undefined,
      bearer('ahk_polaris-product'),
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'product scope forbids this operation',
    });
  });

  it('rejects cross-product reads and owner mutations from a product session', async () => {
    const env = productionEnv();
    const auth = bearer('ahk_polaris-product');
    await expect(
      call(
        'GET',
        '/v1/installation/status?app_id=app-other&environment_id=env-other',
        env,
        undefined,
        auth,
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(403);
    await expect(
      call(
        'GET',
        '/v1/endpoints?app_id=app-other&environment_id=env-other&window=15m',
        env,
        undefined,
        auth,
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(403);
    await expect(
      call(
        'GET',
        '/v1/failures?app_id=app-other&environment_id=env-other&limit=10',
        env,
        undefined,
        auth,
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(403);
    await expect(
      call(
        'POST',
        '/v1/apps',
        env,
        { name: 'other', environment: 'production' },
        auth,
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(403);
    await expect(
      call(
        'POST',
        '/v1/apps/app-1/environments/env-staging/revoke',
        env,
        undefined,
        auth,
        'https://health.sassmaker.com',
      ).then((response) => response.status),
    ).resolves.toBe(403);
  });

  it('serves the dashboard shell without exposing owner data', async () => {
    const env = productionEnv();
    env.ASSETS = { fetch: async () => new Response('<main>Unlock App Health</main>') };
    const response = await call(
      'GET',
      '/',
      env,
      undefined,
      undefined,
      'https://health.sassmaker.com',
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('Unlock App Health');
  });

  it('rejects declared oversized ingest bodies before parsing', async () => {
    const response = await call(
      'POST',
      '/v1/ingest',
      productionEnv(),
      currentBatch(),
      { ...bearer('ahk_production'), 'content-length': String(256 * 1024 + 1) },
      'https://ingest.sassmaker.com',
    );
    expect(response.status).toBe(413);
  });

  it('rejects oversized streamed ingest bodies without a content-length header', async () => {
    const response = await call(
      'POST',
      '/v1/ingest',
      productionEnv(),
      'x'.repeat(256 * 1024 + 1),
      bearer('ahk_production'),
      'https://ingest.sassmaker.com',
    );
    expect(response.status).toBe(413);
  });

  it('marks incomplete production binding responses no-store', async () => {
    const response = await call('GET', '/v1/apps', NON_LOCAL_ENV);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('worker local mode', () => {
  it('creates an app and returns a fresh one-time key', async () => {
    const res = await call('POST', '/v1/apps', LOCAL_ENV, {
      name: SEED_APP_NAME,
      environment: SEED_ENV_NAME,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      app: { id: string; name: string };
      environment: { id: string; name: string };
      key: { key: string; environment_id: null };
    };
    expect(body.app.id).not.toBe(SEED_APP_ID);
    expect(body.environment.id).not.toBe(SEED_ENV_ID);
    expect(body.key.key.startsWith('ahk_')).toBe(true);
    expect(body.key.key).not.toBe(SEED_KEY);
    expect(body.key.environment_id).toBeNull();
  });

  it('creates a new app with a fresh one-time key for non-seed names', async () => {
    const res = await call('POST', '/v1/apps', LOCAL_ENV, {
      name: 'api-service',
      environment: 'staging',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      app: { id: string; name: string };
      environment: { id: string; name: string; app_id: string };
      key: { key: string; environment_id: null };
    };
    expect(body.app.id).not.toBe(SEED_APP_ID);
    expect(body.app.name).toBe('api-service');
    expect(body.environment.name).toBe('staging');
    expect(body.environment.app_id).toBe(body.app.id);
    expect(body.key.key.startsWith('ahk_')).toBe(true);
    expect(body.key.key).not.toBe(SEED_KEY);
    expect(body.key.environment_id).toBeNull();
  });

  it('deduplicates OTLP retries and reports an OTel sampled installation', async () => {
    const createdResponse = await call('POST', '/v1/apps', LOCAL_ENV, {
      name: 'otel-service',
      environment: 'production',
    });
    const created = (await createdResponse.json()) as {
      app: { id: string };
      environment: { id: string };
      key: { key: string };
    };
    const headers = { ...bearer(created.key.key), 'content-type': 'application/json' };
    const payload = otlpJson();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await callRaw('POST', '/v1/traces', LOCAL_ENV, payload, headers);
      expect(response.status).toBe(200);
    }

    const statusResponse = await call(
      'GET',
      `/v1/installation/status?app_id=${created.app.id}&environment_id=${created.environment.id}`,
      LOCAL_ENV,
    );
    await expect(statusResponse.json()).resolves.toMatchObject({
      state: 'connected',
      runtime: 'otel',
    });

    const endpointsResponse = await call(
      'GET',
      `/v1/endpoints?app_id=${created.app.id}&environment_id=${created.environment.id}&window=15m`,
      LOCAL_ENV,
    );
    const endpoints = (await endpointsResponse.json()) as {
      endpoints: { route: string; request_count: number; upstream_sampled?: boolean }[];
    };
    expect(endpoints.endpoints).toContainEqual(
      expect.objectContaining({
        route: '/otel/:id',
        request_count: 1,
        upstream_sampled: true,
      }),
    );
  });

  it('rejects invalid app creation body', async () => {
    const res = await call('POST', '/v1/apps', LOCAL_ENV, { name: '', environment: '' });
    expect(res.status).toBe(400);
  });

  it('returns connected installation status for the seeded app', async () => {
    const res = await call(
      'GET',
      `/v1/installation/status?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('connected');
  });

  it('returns waiting installation status for an unknown app', async () => {
    const res = await call(
      'GET',
      `/v1/installation/status?app_id=other&environment_id=other`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('waiting');
  });

  it('returns seeded endpoint aggregates', async () => {
    const res = await call(
      'GET',
      `/v1/endpoints?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&window=15m`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { method: string; route: string }[] };
    expect(body.endpoints.length).toBeGreaterThan(0);
  });

  it('returns an owner-scoped bounded failure response', async () => {
    const res = await call(
      'GET',
      `/v1/failures?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&limit=25`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: string;
      retention_hours: number;
      limit: number;
      failures: unknown[];
    };
    expect(body).toMatchObject({ window: '24h', retention_hours: 24, limit: 25 });
    expect(Array.isArray(body.failures)).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects an unbounded failure query', async () => {
    const res = await call(
      'GET',
      `/v1/failures?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&limit=1000`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an unsupported window', async () => {
    const res = await call(
      'GET',
      `/v1/endpoints?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&window=99m`,
      LOCAL_ENV,
    );
    expect(res.status).toBe(400);
  });

  it('accepts a supported retained-failure window and rejects an unsupported one', async () => {
    const supported = await call(
      'GET',
      `/v1/failures?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&window=1h`,
      LOCAL_ENV,
    );
    expect(supported.status).toBe(200);
    expect(await supported.json()).toMatchObject({ window: '1h' });

    const unsupported = await call(
      'GET',
      `/v1/failures?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&window=99m`,
      LOCAL_ENV,
    );
    expect(unsupported.status).toBe(400);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await call('GET', '/unknown', LOCAL_ENV);
    expect(res.status).toBe(404);
  });
});
