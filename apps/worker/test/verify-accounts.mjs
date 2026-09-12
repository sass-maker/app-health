import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { Response } from 'miniflare';
import { randomUUID, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { log } from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawnSync } from 'node:child_process';
import { Miniflare } from 'miniflare';
import { makeSignature } from 'better-auth/crypto';

// No production config, credentials, network providers, or persistent data.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(tmpdir(), 'app-health-accounts-runtime-'));
const config = join(scratch, 'wrangler.json');
await writeFile(
  config,
  JSON.stringify({
    name: 'app-health-local-accounts-check',
    main: join(root, 'src/analytics-entry.ts'),
    compatibility_date: '2026-07-22',
    compatibility_flags: ['nodejs_compat'],
  }),
);
const bundle = spawnSync(
  'pnpm',
  [
    'exec',
    'wrangler',
    'deploy',
    '--dry-run',
    '--config',
    config,
    '--outdir',
    join(scratch, 'bundle'),
  ],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
if (bundle.status !== 0) throw new Error(bundle.stderr || bundle.stdout);
const secret = 'synthetic-local-runtime-secret-at-least-32-characters';
const selfAppId = 'self-analytics-canary';
const selfEnvironmentId = 'self-analytics-production';
const mf = new Miniflare({
  cf: false,
  outboundService: async (request) => {
    if (request.url.endsWith('/analytics_engine/sql')) return Response.json({ data: [] });
    throw new Error('External providers are disabled in this test');
  },
  modulesRoot: join(scratch, 'bundle'),
  modules: [{ type: 'ESModule', path: join(scratch, 'bundle/analytics-entry.js') }],
  compatibilityDate: '2026-07-22',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['DB'],
  serviceBindings: {
    ASSETS: async () =>
      new Response('<html>public asset</html>', {
        headers: {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          'x-frame-options': 'DENY',
        },
      }),
  },
  durableObjects: {
    WORKSPACE_PRESENCE: { className: 'WorkspacePresence', useSQLite: true },
    BROWSER_ARCHIVE: { className: 'BrowserArchive', useSQLite: true },
  },
  queueProducers: { BROWSER_EVENTS: 'browser-events' },
  queueConsumers: { 'browser-events': { maxBatchSize: 1, maxBatchTimeout: 0 } },
  r2Buckets: ['BROWSER_HISTORY'],
  analyticsEngineDatasets: {
    TELEMETRY: { dataset: 'local-accounts-test' },
    BROWSER_ANALYTICS: { dataset: 'app_health_browser_v1' },
  },
  bindings: {
    APP_HEALTH_ACCOUNTS: 'enabled',
    APP_HEALTH_SELF_APP_ID: selfAppId,
    APP_HEALTH_SELF_ENVIRONMENT_ID: selfEnvironmentId,
    APP_HEALTH_DASHBOARD_HOST: 'dashboard.example.com',
    APP_HEALTH_INGEST_HOST: 'ingest.example.com',
    APP_HEALTH_INGEST_ORIGIN: 'https://ingest.example.com',
    GOOGLE_CLIENT_ID: 'synthetic-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-google-secret',
    BETTER_AUTH_SECRET: secret,
    OWNER_AUTH_TOKEN: 'synthetic-owner',
    CLOUDFLARE_ACCOUNT_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ANALYTICS_ENGINE_QUERY_TOKEN: 'synthetic-query',
  },
});
try {
  const db = await mf.getD1Database('DB');
  for (const file of (await readdir(join(root, 'migrations')))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = await readFile(join(root, 'migrations', file), 'utf8');
    for (const statement of sql
      .replace(/--[^\n]*/g, '')
      .split(';')
      .filter((part) => part.trim()))
      await db.prepare(statement).run();
  }
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 60_000).toISOString();
  await db
    .prepare('INSERT INTO apps (id, name, created_at) VALUES (?, ?, ?)')
    .bind(selfAppId, 'App Health self analytics', Date.now())
    .run();
  await db
    .prepare('INSERT INTO environments (id, app_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(selfEnvironmentId, selfAppId, 'production', Date.now())
    .run();
  await db
    .prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .bind('local-user', 'Local runtime user', 'local@example.com', now, now)
    .run();
  await db
    .prepare(
      'INSERT INTO session (id, token, userId, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind('local-session', 'synthetic-session-token', 'local-user', expires, now, now)
    .run();
  const signature = await makeSignature('synthetic-session-token', secret);
  const cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`synthetic-session-token.${signature}`)}`;
  const request = async (path, body, authenticated = true) => {
    const controller = new globalThis.AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref();
    try {
      return await mf.dispatchFetch(`https://dashboard.example.com${path}`, {
        signal: controller.signal,
        method: body ? 'POST' : 'GET',
        headers: {
          origin: 'https://dashboard.example.com',
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.1',
          cookie: authenticated ? cookie : '',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } finally {
      clearTimeout(timeout);
    }
  };
  log('Account runtime: schema and synthetic session ready.');
  assert.equal((await request('/v1/health')).status, 200);
  log('Account runtime: health responded.');
  const options = await request('/v1/account/config');
  log('Account runtime: config responded.');
  assert.deepEqual(await options.json(), { google: true });
  const account = await request('/v1/account');
  assert.equal(account.status, 200);
  assert.equal((await account.json()).user.name, 'Local runtime user');
  const ownerRequest = (path) =>
    mf.dispatchFetch(`https://dashboard.example.com${path}`, {
      headers: { authorization: 'Bearer synthetic-owner' },
    });
  const selfLogScope = `app_id=${selfAppId}&environment_id=${selfEnvironmentId}`;
  const signupLogsAfterFirstAccount = await (
    await ownerRequest(`/v1/logs?${selfLogScope}&event=signup.completed`)
  ).json();
  assert.equal(signupLogsAfterFirstAccount.logs.length, 1);
  assert.equal(signupLogsAfterFirstAccount.logs[0].source, 'server');
  assert.deepEqual(signupLogsAfterFirstAccount.logs[0].props, {});
  const repeatedAccount = await request('/v1/account');
  assert.equal(repeatedAccount.status, 200);
  const signupLogsAfterRepeat = await (
    await ownerRequest(`/v1/logs?${selfLogScope}&event=signup.completed`)
  ).json();
  assert.equal(signupLogsAfterRepeat.logs.length, 1);
  const created = await request('/v1/apps', {
    name: 'Worker runtime canary',
    environment: 'production',
  });
  assert.equal(created.status, 201);
  const project = await created.json();
  const failedCreate = await request('/v1/apps', { name: '', environment: 'production' });
  assert.equal(failedCreate.status, 400);
  const selfLogs = await (await ownerRequest(`/v1/logs?${selfLogScope}`)).json();
  assert.equal(selfLogs.logs.filter((row) => row.event === 'project.created').length, 1);
  assert.equal(
    selfLogs.logs.every((row) => row.source === 'server'),
    true,
  );
  assert.equal(
    selfLogs.logs.every((row) => Object.keys(row.props).length === 0),
    true,
  );
  const oversizedEndpoints = await mf.dispatchFetch('https://ingest.example.com/v1/ingest', {
    method: 'POST',
    headers: { authorization: `Bearer ${project.key.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'v1',
      runtime: 'worker',
      environment: 'production',
      batch_id: randomUUID(),
      events: Array.from({ length: 251 }, (_, index) => ({
        event_id: randomUUID(),
        timestamp: Date.now(),
        method: 'GET',
        route: `/capacity-${index}`,
        status_code: 503,
        duration_ms: 10,
      })),
    }),
  });
  assert.equal(oversizedEndpoints.status, 413);
  const endpointStatus = await request(
    `/v1/installation/status?app_id=${project.app.id}&environment_id=${project.environment.id}`,
  );
  assert.equal((await endpointStatus.json()).state, 'waiting');
  log(
    'Endpoint runtime: oversized measurement expansion rejected before installation side effects.',
  );
  const apps = await request('/v1/apps');
  assert.equal((await apps.json()).apps.length, 1);
  assert.equal((await request('/v1/apps', undefined, false)).status, 401);
  const oauth = await request('/v1/auth/sign-in/social', { provider: 'google', callbackURL: '/' });
  assert.equal(oauth.status, 200);
  const destination = new URL((await oauth.json()).url);
  assert.equal(destination.origin, 'https://accounts.google.com');
  assert.equal(destination.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(destination.searchParams.get('state'));
  assert.equal(oauth.headers.get('cache-control'), 'no-store');
  const keyResponse = await request('/v1/public-keys', {
    app_id: project.app.id,
    environment_id: project.environment.id,
    allowed_origins: ['https://website.example.com'],
  });
  assert.equal(keyResponse.status, 201);
  const publicKey = (await keyResponse.json()).key;
  const logBody = {
    schema_version: 'v1',
    batch_id: randomUUID(),
    environment: 'production',
    logs: ['debug', 'info', 'warn', 'error'].map((level) => ({
      log_id: randomUUID(),
      timestamp: Date.now(),
      event: 'runtime.check',
      level,
      props: { attempts: 2, active: true, optional: null, channel: 'server' },
    })),
  };
  const postLogs = (body, browser = false) =>
    mf.dispatchFetch('https://ingest.example.com/v1/logs', {
      method: 'POST',
      headers: browser
        ? { origin: 'https://website.example.com', 'content-type': 'text/plain' }
        : { authorization: `Bearer ${project.key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await postLogs(logBody)).status, 202);
  assert.deepEqual(await (await postLogs(logBody)).json(), {
    accepted: 0,
    duplicates: 4,
    source: 'server',
  });
  const browserLog = {
    ...logBody,
    batch_id: randomUUID(),
    public_key: publicKey,
    logs: [{ ...logBody.logs[3], log_id: randomUUID(), props: { channel: 'browser' } }],
  };
  assert.equal((await postLogs(browserLog, true)).status, 202);
  assert.equal((await (await postLogs(browserLog, true)).json()).duplicates, 1);
  const logScope = `app_id=${project.app.id}&environment_id=${project.environment.id}`;
  const storedLogs = await (await request(`/v1/logs?${logScope}&level=warn`)).json();
  assert.equal(storedLogs.logs.length, 3);
  assert.equal(storedLogs.logs.filter((row) => row.source === 'browser').length, 1);
  assert.equal(
    (
      await postLogs({
        ...logBody,
        batch_id: randomUUID(),
        logs: [{ ...logBody.logs[0], timestamp: Date.now() + 600_000 }],
      })
    ).status,
    400,
  );
  log(
    'Logs runtime: levels, properties, source isolation, replay and timestamp rejection verified.',
  );
  const batch = {
    schema_version: 1,
    batch_id: randomUUID(),
    session_id: randomUUID(),
    public_key: publicKey,
    events: [
      {
        event_id: randomUUID(),
        timestamp: Date.now(),
        type: 'pageview',
        path: '/pricing',
        referrer: '',
      },
    ],
  };
  const collect = (body, origin = 'https://website.example.com') =>
    mf.dispatchFetch('https://ingest.example.com/v1/browser', {
      method: 'POST',
      headers: { origin, 'content-type': 'text/plain' },
      body: JSON.stringify(body),
    });
  assert.equal((await collect(batch, 'https://evil.example.com')).status, 403);
  assert.equal((await collect(batch)).status, 202);
  assert.equal((await collect(batch)).status, 202);
  const summary = await request('/v1/analytics');
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).live.total, 1);
  const report = await request(`/v1/analytics/report?range=1h&app_id=${project.app.id}`);
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal(reportBody.source, 'analytics-engine');
  assert.equal(reportBody.series.length, 24);
  assert.deepEqual(reportBody.events, []);
  assert.equal((await request('/v1/analytics/report?range=7d')).status, 400);
  assert.equal((await request('/v1/analytics/report', undefined, false)).status, 401);
  const sharePath = `/v1/analytics/shares?app_id=${project.app.id}&environment_id=${project.environment.id}`;
  const shareCreation = await request(sharePath, {});
  assert.equal(shareCreation.status, 201);
  const sharing = await shareCreation.json();
  const publicRead = () =>
    mf.dispatchFetch('https://dashboard.example.com/v1/shared/analytics', {
      headers: { authorization: `Bearer ${sharing.token}` },
    });
  const publicResponse = await publicRead();
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  const publicBody = await publicResponse.json();
  assert.equal(publicBody.project.name, 'Worker runtime canary');
  assert.equal(publicBody.live.active, 1);
  assert.deepEqual(Object.keys(publicBody.traffic).sort(), ['from', 'pageviews', 'series', 'to']);
  assert.equal(JSON.stringify(publicBody).includes('/pricing'), false);
  assert.equal(
    (
      await mf.dispatchFetch('https://dashboard.example.com/v1/apps', {
        headers: { authorization: `Bearer ${sharing.token}` },
      })
    ).status,
    403,
  );
  const revoked = await mf.dispatchFetch(
    `https://dashboard.example.com${sharePath}&id=${sharing.share.id}`,
    { method: 'DELETE', headers: { cookie, origin: 'https://dashboard.example.com' } },
  );
  assert.equal(revoked.status, 200);
  assert.equal((await publicRead()).status, 404);
  const publicHtml = await mf.dispatchFetch('https://dashboard.example.com/live');
  assert.equal(publicHtml.status, 200);
  assert.equal(publicHtml.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(publicHtml.headers.get('x-frame-options'), null);
  assert.equal(
    publicHtml.headers.get('content-security-policy'),
    "default-src 'self'; frame-ancestors *",
  );
  const privateHtml = await mf.dispatchFetch('https://dashboard.example.com/app');
  assert.equal(privateHtml.headers.get('x-frame-options'), 'DENY');
  log(
    'Public sharing runtime: scoped reads, immediate revocation and public-only embed policy verified.',
  );
  const bucket = await mf.getR2Bucket('BROWSER_HISTORY');
  const archives = await mf.getDurableObjectNamespace('BROWSER_ARCHIVE');
  const environment = project.environment.id;
  const workspace = (
    await db
      .prepare('SELECT workspace_id FROM workspace_apps WHERE app_id = ?')
      .bind(project.app.id)
      .first()
  ).workspace_id;
  const shard =
    createHash('sha256')
      .update(JSON.stringify([project.app.id, environment, batch.batch_id]))
      .digest()[0] % 16;
  const archive = archives.get(archives.idFromName(`${workspace}:browser-archive-v1:${shard}`));
  // Wait for the real Queue consumer, then drain through the real Durable Object RPC.
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await archive.status()).pending_batches) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await archive.flush();
  const objects = await bucket.list();
  assert.equal(objects.objects.length, 1, 'retry creates one immutable compressed archive');
  const object = await bucket.get(objects.objects[0].key);
  const archived = JSON.parse(
    gunzipSync(Buffer.from(await object.arrayBuffer()))
      .toString()
      .trim(),
  );
  assert.equal(archived.events[0].path, '/pricing');
  assert.equal(archived.session_id, undefined);
  assert.equal(archived.public_key, undefined);
  assert.equal((await collect({ ...batch, batch_id: randomUUID(), events: [] })).status, 202);
  const stream = await mf.dispatchFetch('https://dashboard.example.com/v1/analytics/live', {
    headers: { cookie, origin: 'https://dashboard.example.com', upgrade: 'websocket' },
  });
  assert.equal(stream.status, 101);
  const socket = stream.webSocket;
  const firstFrame = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true }),
  );
  socket.accept();
  assert.equal((await firstFrame).total, 1);
  const secondProject = await (
    await request('/v1/apps', { name: 'Second browser canary', environment: 'production' })
  ).json();
  const secondKey = await (
    await request('/v1/public-keys', {
      app_id: secondProject.app.id,
      environment_id: secondProject.environment.id,
      allowed_origins: ['https://website.example.com'],
    })
  ).json();
  const update = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)), { once: true }),
  );
  assert.equal(
    (await collect({ ...batch, public_key: secondKey.key, batch_id: randomUUID() })).status,
    202,
  );
  const frame = await update;
  assert.equal(frame.total, 2);
  assert.equal(frame.projects.length, 2, 'one existing socket updates both projects');

  assert.equal(
    (
      await mf.dispatchFetch('https://dashboard.example.com/v1/analytics/live', {
        headers: { cookie, origin: 'https://evil.example.com', upgrade: 'websocket' },
      })
    ).status,
    403,
  );
  assert.equal((await request('/v1/analytics', undefined, false)).status, 401);
  socket.close();
  const nativePath = `/v1/native-keys?${logScope}`;
  const nativeCreated = await request(nativePath, {});
  assert.equal(nativeCreated.status, 201);
  const native = await nativeCreated.json();
  const storedNative = await db
    .prepare('SELECT verifier_hash FROM native_keys WHERE id = ?')
    .bind(native.record.id)
    .first();
  assert.equal(storedNative.verifier_hash, createHash('sha256').update(native.key).digest('hex'));
  assert.equal(
    JSON.stringify(await (await request(nativePath)).json()).includes(native.key),
    false,
  );
  const nativeBody = {
    schema_version: 1,
    public_key: native.key,
    batch_id: randomUUID(),
    session_id: randomUUID(),
    active: false,
    events: [
      {
        event_id: randomUUID(),
        timestamp: Date.now(),
        name: 'native.checkout',
        screen: 'checkout',
      },
    ],
    logs: [
      {
        log_id: randomUUID(),
        timestamp: Date.now(),
        event: 'native.ready',
        level: 'info',
        props: { platform: 'swift' },
      },
    ],
  };
  const nativeCollect = (body, headers = {}) =>
    mf.dispatchFetch('https://ingest.example.com/v1/native', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await nativeCollect(nativeBody, { origin: 'https://website.example.com' })).status,
    403,
  );
  assert.equal((await nativeCollect({ ...nativeBody, public_key: publicKey })).status, 400);
  assert.equal((await nativeCollect(nativeBody)).status, 202);
  assert.equal((await nativeCollect(nativeBody)).status, 202);
  const nativeLogs = await (await request(`/v1/logs?${logScope}&source=native`)).json();
  assert.equal(nativeLogs.logs.length, 1, 'native retry does not duplicate stored logs');
  assert.equal(nativeLogs.logs[0].source, 'native');
  assert.equal(
    (await (await request('/v1/analytics')).json()).live.total,
    2,
    'background native events do not add presence',
  );
  assert.equal(
    (
      await nativeCollect({
        ...nativeBody,
        batch_id: randomUUID(),
        active: true,
        events: [],
        logs: [],
      })
    ).status,
    202,
  );
  assert.equal((await (await request('/v1/analytics')).json()).live.total, 3);
  const nativeRevoked = await mf.dispatchFetch(
    `https://dashboard.example.com${nativePath}&id=${native.record.id}`,
    {
      method: 'DELETE',
      headers: { cookie, origin: 'https://dashboard.example.com' },
    },
  );
  assert.equal(nativeRevoked.status, 200);
  assert.equal((await nativeCollect(nativeBody)).status, 403);
  log(
    'Native runtime: hashed scoped key, ingestion, replay, native logs, opt-in presence and revocation verified.',
  );
  log(
    'Browser runtime: queue, immutable archive, scoped live stream, and origin rejection verified.',
  );
  assert.equal((await request('/v1/auth/sign-out', {})).status, 200);
  assert.equal((await request('/v1/apps')).status, 401);
  log(
    JSON.stringify(
      {
        mode: 'local-workerd-d1',
        workspace: 'verified',
        projectOwnership: 'verified',
        oauthInitiation: 'verified',
        signOut: 'verified',
        googleCallback: 'requires real provider configuration',
      },
      null,
      2,
    ),
  );
} finally {
  await mf.dispose();
}
