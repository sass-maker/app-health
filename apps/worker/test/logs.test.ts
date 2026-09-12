import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.js';
import { AppHealthService, InMemoryAdapter } from '../src/index.js';
import {
  D1ControlPlane,
  type D1DatabaseLike,
  type D1PreparedStatement,
} from '../src/d1-adapter.js';
import { buildLogAlert, deliverLogAlerts, escapeMrkdwn } from '../src/log-alerts.js';
import { resolveLogRoutes } from '../src/log-routing.js';
import {
  SEED_APP_ID,
  SEED_ENV_ID,
  SEED_KEY,
  SEED_ENV_NAME,
  SEED_PUBLIC_KEY,
  SEED_PUBLIC_KEY_ORIGINS,
  BROWSER_LOGS_PER_MINUTE,
  defaultLogRoutes,
  type CreatePublicLogKeyResponseV1,
  type LogEventV1,
  type LogQueryResponseV1,
} from '@app-health/contracts';

const LOCAL_ENV: Env = { APP_HEALTH_MODE: 'local' };
const NOW = Date.now();

function logId(n: number): string {
  return `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
}

function log(n: number, overrides: Partial<LogEventV1> = {}): LogEventV1 {
  return {
    log_id: logId(n),
    timestamp: NOW + n,
    event: 'signup',
    level: 'info',
    props: {},
    ...overrides,
  };
}

/** `null` omits the environment field entirely; the default targets the seeded environment. */
function batch(logs: unknown[], environment: string | null = SEED_ENV_NAME) {
  return { schema_version: 'v1', ...(environment === null ? {} : { environment }), logs };
}

async function call(
  method: string,
  path: string,
  env: Env,
  body?: unknown,
  headers?: Record<string, string>,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return worker.fetch(new Request(new URL(`https://worker.local${path}`), init), env, ctx);
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe('log ingest and query routes', () => {
  it('accepts a bearer-keyed log batch and lists it for the owner', async () => {
    const posted = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      batch([
        log(1, { title: 'a@b.co', props: { plan: 'free', seats: 2 } }),
        log(2, { event: 'payment.failed', level: 'error', description: 'card declined' }),
      ]),
      bearer(SEED_KEY),
    );
    expect(posted.status).toBe(202);
    await expect(posted.json()).resolves.toEqual({ accepted: 2, duplicates: 0, source: 'server' });

    const listed = await call(
      'GET',
      `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}`,
      LOCAL_ENV,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as LogQueryResponseV1;
    expect(body.retention_days).toBe(30);
    expect(body.logs.map((entry) => entry.event)).toEqual(['payment.failed', 'signup']);
    expect(body.logs[1]).toMatchObject({ title: 'a@b.co', props: { plan: 'free', seats: 2 } });

    const errorsOnly = (await (
      await call(
        'GET',
        `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&level=warn&limit=5`,
        LOCAL_ENV,
      )
    ).json()) as LogQueryResponseV1;
    expect(errorsOnly.logs.map((entry) => entry.event)).toEqual(['payment.failed']);
    expect(errorsOnly.limit).toBe(5);

    const byEvent = (await (
      await call(
        'GET',
        `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&event=signup`,
        LOCAL_ENV,
      )
    ).json()) as LogQueryResponseV1;
    expect(byEvent.logs).toHaveLength(1);
  });

  it('rejects missing keys, invalid batches, wrong methods, and bad queries', async () => {
    expect((await call('POST', '/v1/logs', LOCAL_ENV, batch([log(1)]))).status).toBe(401);
    const invalid = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      batch([{ ...log(1), event: 'Bad Name' }]),
      bearer(SEED_KEY),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'invalid log batch',
      details: [expect.stringContaining('logs.0.event')],
    });
    expect((await call('POST', '/v1/logs', LOCAL_ENV, 'not json', bearer(SEED_KEY))).status).toBe(
      400,
    );
    expect((await call('PUT', `/v1/logs?app_id=${SEED_APP_ID}`, LOCAL_ENV)).status).toBe(405);
    expect((await call('GET', '/v1/logs?app_id=only', LOCAL_ENV)).status).toBe(400);
    expect(
      (
        await call(
          'GET',
          `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&limit=9999`,
          LOCAL_ENV,
        )
      ).status,
    ).toBe(400);
  });

  it('rejects oversized log bodies', async () => {
    const huge = batch([log(1, { description: 'x'.repeat(2000) })]);
    const response = await call('POST', '/v1/logs', LOCAL_ENV, huge, {
      ...bearer(SEED_KEY),
      'content-length': String(300 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it('is unavailable outside local mode without production bindings', async () => {
    expect((await call('POST', '/v1/logs', {}, batch([log(1)]), bearer(SEED_KEY))).status).toBe(
      503,
    );
  });
});

describe('log alerts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts alerts through waitUntil when a webhook is configured', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const pending: Promise<unknown>[] = [];
    const env: Env = {
      ...LOCAL_ENV,
      LOG_ALERT_WEBHOOK_URL: 'https://hooks.slack.test/abc',
      LOG_ALERT_MIN_LEVEL: 'warn',
    };
    const response = await call(
      'POST',
      '/v1/logs',
      env,
      {
        ...batch([log(1), log(2, { event: 'boom', level: 'error', title: 'x <y>' })]),
        batch_id: '11111111-2222-4333-a444-000000000099',
      },
      bearer(SEED_KEY),
      { waitUntil: (promise) => pending.push(promise) },
    );
    expect(response.status).toBe(202);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.test/abc');
    const payload = JSON.parse(String(init.body)) as { text: string };
    expect(payload.text).toBe(`[demo-app/${SEED_ENV_NAME}] boom: x <y>`);
    expect(String(init.body)).toContain('&lt;y&gt;');
  });

  it('awaits alerts inline without a context and tolerates webhook failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const env: Env = {
      ...LOCAL_ENV,
      LOG_ALERT_WEBHOOK_URL: 'https://hooks.slack.test/abc',
      LOG_ALERT_MIN_LEVEL: 'not-a-level',
    };
    const response = await call(
      'POST',
      '/v1/logs',
      env,
      batch([log(1), log(2), log(3, { level: 'debug' })]),
      bearer(SEED_KEY),
    );
    expect(response.status).toBe(202);
    // Default threshold is info, so the debug log is skipped and two deliveries were attempted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('renders titles, descriptions, props, overflow, and level tags', () => {
    const props = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    const rich = buildLogAlert(
      log(1, { level: 'warn', title: 'T', description: 'D & more', props: { ...props, n: null } }),
      { appName: 'karte', environmentName: 'production' },
    ) as { text: string; blocks: Record<string, unknown>[] };
    expect(rich.text).toBe('[karte/production] signup: T');
    expect(rich.blocks).toHaveLength(5);
    expect(JSON.stringify(rich.blocks[0])).toContain('⚠️');
    expect(JSON.stringify(rich.blocks[0])).toContain('`WARN`');
    expect(JSON.stringify(rich.blocks[1])).toContain('D &amp; more');
    expect(JSON.stringify(rich.blocks[3])).toContain('_null_');

    const plain = buildLogAlert(log(2, { icon: '💳' }), { appName: 'a', environmentName: 'b' }) as {
      blocks: Record<string, unknown>[];
    };
    expect(plain.blocks).toHaveLength(2);
    expect(JSON.stringify(plain.blocks[0])).toContain('💳');
    expect(escapeMrkdwn('a & <b>')).toBe('a &amp; &lt;b&gt;');
  });

  it('deliverLogAlerts counts successes and skips below-threshold logs', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const delivered = await deliverLogAlerts([log(1), log(2, { level: 'error' })], {
      webhookUrl: 'https://hooks.slack.test/x',
      minLevel: 'error',
      appName: 'a',
      environmentName: 'b',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(delivered).toBe(1);
  });
});

describe('log service and in-memory repository', () => {
  it('does not expose expired logs while physical cleanup is pending', async () => {
    const adapter = await InMemoryAdapter.create();
    await adapter.recordLogs(
      SEED_APP_ID,
      SEED_ENV_ID,
      [log(1, { timestamp: NOW - 31 * 86_400_000 }), log(2)],
      'server',
    );
    const rows = await adapter.listLogs(SEED_APP_ID, SEED_ENV_ID, { minLevel: 'debug', limit: 10 });
    expect(rows.map((row) => row.log_id)).toEqual([logId(2)]);
  });
  it('dedupes repeated log ids and routes product keys by environment', async () => {
    const adapter = await InMemoryAdapter.create();
    const service = new AppHealthService(adapter.asRepositories());
    const first = await service.ingestLogs(SEED_KEY, batch([log(1), log(1)]), NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first).toMatchObject({ accepted: 2, app_id: SEED_APP_ID, environment_id: SEED_ENV_ID });
    const listed = await adapter.listLogs(SEED_APP_ID, SEED_ENV_ID, {
      minLevel: 'debug',
      limit: 10,
    });
    expect(listed).toHaveLength(1);

    const created = await service.createApp({ name: 'orders', environment: 'staging' }, NOW);
    const productKey = created.key.key;
    // Product keys route by the batch's environment name, so omitting it is rejected.
    const missingEnv = await service.ingestLogs(productKey, batch([log(5)], null), NOW);
    expect(missingEnv).toMatchObject({ ok: false, status: 400 });
    const routed = await service.ingestLogs(productKey, batch([log(6)], 'staging'), NOW);
    expect(routed.ok).toBe(true);
    const response = await service.queryLogs(
      created.app.id,
      created.environment.id,
      { level: 'debug', limit: 50 },
      NOW,
    );
    expect(response.logs.map((entry) => entry.log_id)).toEqual([logId(6)]);
  });

  it('returns an empty response when no log repository is configured', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    delete repos.logs;
    const service = new AppHealthService(repos);
    const ingested = await service.ingestLogs(SEED_KEY, batch([log(1)]), NOW);
    expect(ingested.ok).toBe(true);
    const listed = await service.queryLogs(
      SEED_APP_ID,
      SEED_ENV_ID,
      { level: 'debug', limit: 10 },
      NOW,
    );
    expect(listed.logs).toEqual([]);
  });
});

class Statement implements D1PreparedStatement {
  values: unknown[] = [];
  constructor(
    readonly sql: string,
    private readonly db: FakeDatabase,
  ) {}
  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.firstResults.shift() as T | null | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: (this.db.allResults.shift() as T[] | undefined) ?? [] };
  }
  async run() {
    return { success: true, meta: { changes: this.db.changes } };
  }
}

class FakeDatabase implements D1DatabaseLike {
  statements: Statement[] = [];
  allResults: unknown[][] = [];
  firstResults: unknown[] = [];
  changes = 3;
  failBatch = false;
  prepare(sql: string): D1PreparedStatement {
    const statement = new Statement(sql, this);
    this.statements.push(statement);
    return statement;
  }
  async batch(statements: D1PreparedStatement[]) {
    return statements.map(() => ({ success: !this.failBatch, meta: { changes: 1 } }));
  }
}

describe('D1 log storage', () => {
  it('inserts logs with nulls for absent text and JSON props', async () => {
    const db = new FakeDatabase();
    const control = new D1ControlPlane(db);
    await control.recordLogs('app', 'env', [], 'server');
    expect(db.statements).toHaveLength(0);
    await control.recordLogs('app', 'env', [log(1, { title: 'hi', props: { a: 1 } })], 'browser');
    expect(db.statements[0].sql).toContain('INSERT OR IGNORE INTO log_events');
    expect(db.statements[0].values).toEqual([
      logId(1),
      'app',
      'env',
      NOW + 1,
      'signup',
      'info',
      'hi',
      null,
      null,
      '{"a":1}',
      'browser',
    ]);
    db.failBatch = true;
    await expect(control.recordLogs('app', 'env', [log(2)], 'server')).rejects.toThrow(
      'D1 log insert failed',
    );
  });

  it('lists logs with a level range, optional event filter, and rehydrated props', async () => {
    const db = new FakeDatabase();
    db.allResults.push([
      {
        log_id: logId(1),
        timestamp: NOW,
        event: 'signup',
        level: 'warn',
        title: 'a@b.co',
        description: null,
        icon: null,
        props: '{"plan":"free"}',
        source: 'browser',
      },
    ]);
    const control = new D1ControlPlane(db);
    const logs = await control.listLogs('app', 'env', {
      minLevel: 'warn',
      source: 'browser',
      event: 'signup',
      limit: 7,
    });
    expect(logs).toEqual([
      {
        log_id: logId(1),
        timestamp: NOW,
        event: 'signup',
        level: 'warn',
        source: 'browser',
        title: 'a@b.co',
        props: { plan: 'free' },
      },
    ]);
    expect(db.statements[0].sql).toContain('level IN (?, ?)');
    expect(db.statements[0].sql).toContain('AND source = ?');
    expect(db.statements[0].sql).toContain('AND event = ?');
    expect(db.statements[0].values).toEqual([
      'app',
      'env',
      expect.any(Number),
      expect.any(Number),
      'warn',
      'error',
      'browser',
      'signup',
      7,
    ]);

    await control.listLogs('app', 'env', { minLevel: 'debug', limit: 1 });
    expect(db.statements[1].values).toEqual([
      'app',
      'env',
      expect.any(Number),
      expect.any(Number),
      'debug',
      'info',
      'warn',
      'error',
      1,
    ]);
    expect(db.statements[1].sql).toContain('timestamp >= ?');
    expect(Number(db.statements[1].values[2])).toBeGreaterThanOrEqual(NOW - 30 * 86_400_000);
    expect(db.statements[1].sql).not.toContain('AND event');
    expect(db.statements[1].sql).not.toContain('AND source');
    expect(db.statements[1].sql).not.toContain('AND source');
  });

  it('prunes expired logs in bounded batches', async () => {
    const db = new FakeDatabase();
    const removed = await new D1ControlPlane(db).cleanupLogsExpired(NOW, 10);
    expect(removed).toBe(3);
    expect(db.statements[0].sql).toContain('DELETE FROM log_events');
    expect(db.statements[0].values).toEqual([NOW, 10]);
  });

  it('runs log cleanup from the scheduled handler', async () => {
    const db = new FakeDatabase();
    await worker.scheduled(undefined, { DB: db });
    expect(
      db.statements.some((statement) => statement.sql.includes('DELETE FROM log_events')),
    ).toBe(true);
    expect(
      db.statements.some((statement) => statement.sql.includes('DELETE FROM browser_log_quota')),
    ).toBe(true);
  });
});

describe('D1 public keys and quota', () => {
  it('creates, verifies, lists, and revokes public keys and counts quota', async () => {
    const db = new FakeDatabase();
    const control = new D1ControlPlane(db);
    const created = await control.createPublicKey('app', 'env', ['https://karte.app'], NOW);
    expect(created.rawKey.startsWith('ahk_pub_')).toBe(true);
    expect(created.record).toMatchObject({
      app_id: 'app',
      environment_id: 'env',
      revoked_at: null,
    });
    expect(db.statements[0].sql).toContain('INSERT INTO public_log_keys');
    expect(db.statements[0].values[4]).toBe('["https://karte.app"]');

    db.firstResults.push({
      id: 'pubkey-1',
      app_id: 'app',
      environment_id: 'env',
      allowed_origins: '["https://karte.app"]',
      created_at: NOW,
      revoked_at: null,
    });
    expect(await control.verifyPublicKey('ahk_pub_x')).toMatchObject({
      id: 'pubkey-1',
      allowed_origins: ['https://karte.app'],
    });
    expect(await control.verifyPublicKey('ahk_pub_y')).toBeNull();

    db.allResults.push([
      {
        id: 'pubkey-1',
        app_id: 'app',
        environment_id: 'env',
        allowed_origins: '[]',
        created_at: 1,
        revoked_at: 2,
      },
    ]);
    expect((await control.listPublicKeys('app'))[0].revoked_at).toBe(2);

    expect(await control.revokePublicKey('pubkey-1', NOW)).toBe(true);
    db.changes = 0;
    expect(await control.revokePublicKey('pubkey-1', NOW)).toBe(false);

    db.firstResults.push({ count: 42 });
    expect(await control.consumeBrowserQuota('pubkey-1', NOW, 2)).toBe(42);
    expect(await control.consumeBrowserQuota('pubkey-1', NOW, 3)).toBe(3);
    expect(db.statements.at(-1)?.sql).toContain('ON CONFLICT (key_id, window_start)');
    expect(await control.cleanupBrowserQuotaExpired(NOW)).toBe(0);
  });
});

function browserBatch(logs: unknown[], publicKey = SEED_PUBLIC_KEY, environment?: string) {
  return {
    schema_version: 'v1',
    public_key: publicKey,
    ...(environment ? { environment } : {}),
    logs,
  };
}
const ORIGIN = SEED_PUBLIC_KEY_ORIGINS[0];

describe('browser log ingest', () => {
  it('accepts a public-key batch from an allowed origin, tags it as browser, and echoes CORS', async () => {
    const response = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      browserBatch([log(501, { title: 'clicked' })]),
      {
        origin: ORIGIN,
        'content-type': 'text/plain',
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
      source: 'browser',
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const listed = (await (
      await call(
        'GET',
        `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&source=browser`,
        LOCAL_ENV,
      )
    ).json()) as LogQueryResponseV1;
    expect(listed.logs.map((entry) => entry.source)).toEqual(['browser']);
    const serverOnly = (await (
      await call(
        'GET',
        `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&source=server`,
        LOCAL_ENV,
      )
    ).json()) as LogQueryResponseV1;
    expect(serverOnly.logs.every((entry) => entry.source === 'server')).toBe(true);
  });

  it('answers CORS preflight on the ingest host', async () => {
    const response = await call('OPTIONS', '/v1/logs', LOCAL_ENV, undefined, { origin: ORIGIN });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('rejects unknown keys, disallowed or missing origins, and mismatched environments', async () => {
    const bad = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      browserBatch([log(502)], 'ahk_pub_nope'),
      {
        origin: ORIGIN,
      },
    );
    expect(bad.status).toBe(401);
    const wrongOrigin = await call('POST', '/v1/logs', LOCAL_ENV, browserBatch([log(503)]), {
      origin: 'https://evil.example',
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get('access-control-allow-origin')).toBe('https://evil.example');
    expect((await call('POST', '/v1/logs', LOCAL_ENV, browserBatch([log(504)]))).status).toBe(403);
    const mismatch = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      browserBatch([log(505)], SEED_PUBLIC_KEY, 'staging'),
      {
        origin: ORIGIN,
      },
    );
    expect(mismatch.status).toBe(400);
    const invalid = await call(
      'POST',
      '/v1/logs',
      LOCAL_ENV,
      browserBatch([{ ...log(506), event: 'Bad' }]),
      {
        origin: ORIGIN,
      },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid browser log batch' });
  });

  it('rate limits a public key per minute', async () => {
    const adapter = await InMemoryAdapter.create();
    const service = new AppHealthService(adapter.asRepositories());
    const big = Array.from({ length: 100 }, (_, i) => log(1000 + i));
    for (let batch = 0; batch < BROWSER_LOGS_PER_MINUTE / 100; batch += 1) {
      const ok = await service.ingestBrowserLogs(
        browserBatch(big),
        ORIGIN,
        NOW,
        defaultLogRoutes(),
      );
      expect(ok.ok).toBe(true);
    }
    const over = await service.ingestBrowserLogs(
      browserBatch([log(507)]),
      ORIGIN,
      NOW,
      defaultLogRoutes(),
    );
    expect(over).toMatchObject({ ok: false, status: 429 });
    const nextMinute = await service.ingestBrowserLogs(
      browserBatch([log(508)]),
      ORIGIN,
      NOW + 60_000,
    );
    expect(nextMinute.ok).toBe(true);
  });

  it('fails closed when the public key repository is missing', async () => {
    const adapter = await InMemoryAdapter.create();
    const repos = adapter.asRepositories();
    delete repos.publicKeys;
    const service = new AppHealthService(repos);
    expect(await service.ingestBrowserLogs(browserBatch([log(509)]), ORIGIN, NOW)).toMatchObject({
      status: 401,
    });
    expect(
      await service.createPublicKey(
        { app_id: SEED_APP_ID, environment_id: SEED_ENV_ID, allowed_origins: [ORIGIN] },
        NOW,
      ),
    ).toBeNull();
    expect(await service.listPublicKeys(SEED_APP_ID)).toEqual([]);
    expect(await service.revokePublicKey('x', NOW)).toBe(false);
  });
});

describe('public key routes', () => {
  it('creates a key once, lists it, and revokes it', async () => {
    const created = await call('POST', '/v1/public-keys', LOCAL_ENV, {
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      allowed_origins: ['https://karte.app'],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as CreatePublicLogKeyResponseV1;
    expect(body.key.startsWith('ahk_pub_')).toBe(true);
    expect(body.record.allowed_origins).toEqual(['https://karte.app']);

    const listed = await call('GET', `/v1/public-keys?app_id=${SEED_APP_ID}`, LOCAL_ENV);
    const keys = ((await listed.json()) as { keys: { id: string }[] }).keys;
    expect(keys.map((key) => key.id)).toContain(body.record.id);

    const accepted = await call('POST', '/v1/logs', LOCAL_ENV, browserBatch([log(510)], body.key), {
      origin: 'https://karte.app',
    });
    expect(accepted.status).toBe(202);

    const revoked = await call('POST', `/v1/public-keys/${body.record.id}/revoke`, LOCAL_ENV);
    expect(revoked.status).toBe(200);
    expect((await call('POST', `/v1/public-keys/${body.record.id}/revoke`, LOCAL_ENV)).status).toBe(
      404,
    );
    const rejected = await call('POST', '/v1/logs', LOCAL_ENV, browserBatch([log(511)], body.key), {
      origin: 'https://karte.app',
    });
    expect(rejected.status).toBe(401);
  });

  it('validates requests and methods', async () => {
    expect((await call('GET', '/v1/public-keys', LOCAL_ENV)).status).toBe(400);
    expect((await call('PUT', '/v1/public-keys', LOCAL_ENV)).status).toBe(405);
    expect((await call('GET', '/v1/public-keys/x/revoke', LOCAL_ENV)).status).toBe(405);
    const badOrigin = await call('POST', '/v1/public-keys', LOCAL_ENV, {
      app_id: SEED_APP_ID,
      environment_id: SEED_ENV_ID,
      allowed_origins: ['nope'],
    });
    expect(badOrigin.status).toBe(400);
    const missingEnv = await call('POST', '/v1/public-keys', LOCAL_ENV, {
      app_id: SEED_APP_ID,
      environment_id: 'env-missing',
      allowed_origins: ['https://a.b'],
    });
    expect(missingEnv.status).toBe(404);
  });
});

describe('log routing configuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('falls back to defaults for missing or invalid LOG_ROUTES', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveLogRoutes({})).toEqual(defaultLogRoutes('info'));
    expect(resolveLogRoutes({ LOG_ALERT_MIN_LEVEL: 'warn' })[1].match.min_level).toBe('warn');
    expect(resolveLogRoutes({ LOG_ROUTES: '{not json' })).toEqual(defaultLogRoutes('info'));
    expect(resolveLogRoutes({ LOG_ROUTES: '[{"sinks":["email"]}]' })).toEqual(
      defaultLogRoutes('info'),
    );
    expect(errorSpy).toHaveBeenCalledTimes(2);
    const custom = resolveLogRoutes({
      LOG_ROUTES: '[{"match":{"event":"signup"},"sinks":["slack"]}]',
    });
    expect(custom).toEqual([{ match: { event: 'signup' }, sinks: ['slack'] }]);
  });

  it('routes decide what is stored and what reaches Slack', async () => {
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env: Env = {
      ...LOCAL_ENV,
      LOG_ALERT_WEBHOOK_URL: 'https://hooks.slack.test/abc',
      LOG_ROUTES: JSON.stringify([
        { match: { source: 'server' }, sinks: ['store'] },
        { match: { event: 'payment.failed' }, sinks: ['slack'] },
      ]),
    };
    const response = await call(
      'POST',
      '/v1/logs',
      env,
      batch([
        log(512, { event: 'payment.failed' }),
        log(513, { event: 'quiet.debug', level: 'debug' }),
      ]),
      bearer(SEED_KEY),
    );
    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Browser logs match no store rule under these routes: accepted, delivered nowhere, not kept.
    const dropped = await call(
      'POST',
      '/v1/logs',
      env,
      browserBatch([log(514, { event: 'ui.click' })]),
      {
        origin: ORIGIN,
      },
    );
    expect(dropped.status).toBe(202);
    const listed = (await (
      await call(
        'GET',
        `/v1/logs?app_id=${SEED_APP_ID}&environment_id=${SEED_ENV_ID}&event=ui.click`,
        LOCAL_ENV,
      )
    ).json()) as LogQueryResponseV1;
    expect(listed.logs).toHaveLength(0);
  });
});
