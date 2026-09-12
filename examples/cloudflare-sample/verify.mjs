import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const sampleRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sampleRoot, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'app-health-cloudflare-sample-'));
const webRequire = createRequire(join(projectRoot, 'apps/web/package.json'));
const workerRequire = createRequire(join(projectRoot, 'apps/worker/package.json'));
const sdkRequire = createRequire(join(projectRoot, 'packages/node/package.json'));
const { build, createServer } = await import(webRequire.resolve('vite'));
const playwright = await import(webRequire.resolve('@playwright/test'));
const { chromium } = playwright.default ?? playwright;
const { Miniflare } = await import(workerRequire.resolve('miniflare'));
const COMPATIBILITY_DATE = '2026-07-29';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function availablePort() {
  const server = createNetServer();
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolveClosed, reject) =>
    server.close((error) => (error ? reject(error) : resolveClosed())),
  );
  return address.port;
}

function bundledCode(result) {
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    const chunk = output.output.find((item) => item.type === 'chunk' && item.isEntry);
    if (chunk) return chunk.code;
  }
  throw new Error('Vite did not produce an entry bundle');
}

async function typecheckSample() {
  const common = {
    extends: join(projectRoot, 'tsconfig.base.json'),
    compilerOptions: { noEmit: true, baseUrl: projectRoot },
  };
  const configs = [
    {
      ...common,
      compilerOptions: {
        ...common.compilerOptions,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        paths: { '@saas-maker/app-health/web': ['packages/node/dist/web.d.ts'] },
      },
      files: [join(sampleRoot, 'browser.ts')],
    },
    {
      ...common,
      compilerOptions: {
        ...common.compilerOptions,
        lib: ['ES2022', 'DOM'],
        paths: {
          '@saas-maker/app-health': ['packages/node/dist/index.d.ts'],
          '@saas-maker/app-health/hono': ['packages/node/dist/hono.d.ts'],
          hono: ['packages/node/node_modules/hono'],
        },
      },
      files: [join(sampleRoot, 'worker.ts')],
    },
  ];
  for (const [index, config] of configs.entries()) {
    const configPath = join(scratch, `tsconfig-${index}.json`);
    await writeFile(configPath, JSON.stringify(config));
    run('pnpm', ['exec', 'tsc', '-p', configPath]);
  }
}

async function buildSample() {
  run('pnpm', ['--filter', '@saas-maker/app-health', 'build']);
  await typecheckSample();
  const honoEntry = resolve(dirname(sdkRequire.resolve('hono')), '../index.js');
  const aliases = [
    {
      find: /^@saas-maker\/app-health\/hono$/u,
      replacement: join(projectRoot, 'packages/node/dist/hono.js'),
    },
    {
      find: /^@saas-maker\/app-health\/web$/u,
      replacement: join(projectRoot, 'packages/node/dist/web.js'),
    },
    {
      find: /^@saas-maker\/app-health$/u,
      replacement: join(projectRoot, 'packages/node/dist/index.js'),
    },
    {
      find: /^hono\/route$/u,
      replacement: join(dirname(honoEntry), 'helper/route/index.js'),
    },
    { find: /^hono$/u, replacement: honoEntry },
  ];
  const browserResult = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: aliases },
    build: {
      write: false,
      target: 'es2022',
      lib: { entry: join(sampleRoot, 'browser.ts'), formats: ['iife'], name: 'CheckoutSample' },
    },
  });
  const workerResult = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: aliases },
    build: {
      write: false,
      target: 'es2022',
      lib: { entry: join(sampleRoot, 'worker.ts'), formats: ['es'] },
    },
  });
  const workerPath = join(scratch, 'worker.js');
  const browserScript = bundledCode(browserResult);
  await writeFile(workerPath, bundledCode(workerResult));
  const tracker = await readFile(join(projectRoot, 'apps/web/public/tracker.js'));
  return {
    browserScript,
    workerPath,
    assetSizes: {
      browserBundleBytes: Buffer.byteLength(browserScript),
      browserBundleGzipBytes: gzipSync(browserScript).byteLength,
      trackerBytes: tracker.byteLength,
      trackerGzipBytes: gzipSync(tracker).byteLength,
    },
  };
}

const TELEMETRY_PATHS = new Set(['/v1/browser', '/v1/ingest', '/v1/logs']);

async function startCollectorProxy(collectorOrigin) {
  const stats = { requests: 0, payloadBytes: 0, byPath: {} };
  const server = createHttpServer(async (request, response) => {
    try {
      const path = new globalThis.URL(request.url ?? '/', collectorOrigin).pathname;
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (TELEMETRY_PATHS.has(path)) {
        stats.requests += 1;
        stats.payloadBytes += body.byteLength;
        const current = stats.byPath[path] ?? { requests: 0, payloadBytes: 0 };
        stats.byPath[path] = {
          requests: current.requests + 1,
          payloadBytes: current.payloadBytes + body.byteLength,
        };
      }
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && name !== 'host' && name !== 'content-length')
          headers[name] = value;
      }
      const upstream = await globalThis.fetch(`${collectorOrigin}${request.url ?? '/'}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
      });
      response.statusCode = upstream.status;
      upstream.headers.forEach((value, name) => {
        if (
          !['connection', 'content-encoding', 'content-length', 'transfer-encoding'].includes(name)
        )
          response.setHeader(name, value);
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (cause) {
      response.statusCode = 502;
      response.end(cause instanceof Error ? cause.message : 'collector proxy failed');
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return { server, stats, origin: `http://127.0.0.1:${address.port}` };
}

async function jsonRequest(origin, path, init = {}) {
  const response = await globalThis.fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  assert.equal(response.ok, true, `${init.method ?? 'GET'} ${path} returned ${response.status}`);
  return response.json();
}

async function createTargets(collectorOrigin, origins) {
  const production = await jsonRequest(collectorOrigin, '/v1/apps', {
    method: 'POST',
    body: { name: 'Northstar Checkout', environment: 'production', key_scope: 'environment' },
  });
  const staging = await jsonRequest(
    collectorOrigin,
    `/v1/apps/${encodeURIComponent(production.app.id)}/environments`,
    { method: 'POST', body: { name: 'staging' } },
  );
  const environments = [production, staging];
  return Promise.all(
    environments.map(async (created, index) => {
      const publicKey = await jsonRequest(collectorOrigin, '/v1/public-keys', {
        method: 'POST',
        body: {
          app_id: production.app.id,
          environment_id: created.environment.id,
          allowed_origins: [origins[index]],
        },
      });
      return {
        appId: production.app.id,
        environmentId: created.environment.id,
        environment: created.environment.name,
        origin: origins[index],
        privateKey: created.key.key,
        publicKey: publicKey.key,
      };
    }),
  );
}

function sampleOptions(target, collectorOrigin, bundle) {
  return {
    host: '127.0.0.1',
    port: Number(new globalThis.URL(target.origin).port),
    modulesRoot: scratch,
    modules: [{ type: 'ESModule', path: bundle.workerPath }],
    compatibilityDate: COMPATIBILITY_DATE,
    compatibilityFlags: ['nodejs_compat'],
    bindings: {
      APP_HEALTH_BROWSER_SCRIPT: bundle.browserScript,
      APP_HEALTH_INGEST_ORIGIN: collectorOrigin,
      APP_HEALTH_PRIVATE_KEY: target.privateKey,
      APP_HEALTH_PUBLIC_KEY: target.publicKey,
      APP_HEALTH_ENVIRONMENT: target.environment,
    },
  };
}

function scope(target) {
  return new globalThis.URLSearchParams({
    app_id: target.appId,
    environment_id: target.environmentId,
  }).toString();
}

async function reports(collectorOrigin, target) {
  const query = scope(target);
  const [analytics, endpoints, logs, capabilities, failures] = await Promise.all([
    jsonRequest(collectorOrigin, `/v1/analytics/report?range=1h&${query}`),
    jsonRequest(collectorOrigin, `/v1/endpoints?window=15m&${query}`),
    jsonRequest(collectorOrigin, `/v1/logs?${query}`),
    jsonRequest(collectorOrigin, `/v1/capabilities?${query}`),
    jsonRequest(collectorOrigin, `/v1/failures?window=1h&${query}`),
  ]);
  return { analytics, endpoints, logs, capabilities, failures };
}

function hasCompleteReceipt(report, environment) {
  const browserEvent = `checkout.${environment}.completed`;
  const serverEvent = `order.${environment}.completed`;
  const unavailable = report.endpoints.endpoints.find(
    (endpoint) => endpoint.route === '/api/checkout/unavailable',
  );
  return (
    report.analytics.events.some((event) => event.name === browserEvent && event.count >= 1) &&
    report.endpoints.endpoints.some(
      (endpoint) => endpoint.route === '/api/checkout' && endpoint.request_count >= 1,
    ) &&
    report.endpoints.endpoints.some(
      (endpoint) => endpoint.route === '/api/products/:sku' && endpoint.request_count >= 1,
    ) &&
    report.logs.logs.some((log) => log.event === browserEvent && log.source === 'browser') &&
    report.logs.logs.some((log) => log.event === serverEvent && log.source === 'server') &&
    unavailable?.request_count >= 1 &&
    unavailable.error_rate === 1 &&
    report.failures.failures.some(
      (failure) => failure.route === '/api/checkout/unavailable' && failure.status_code === 503,
    ) &&
    report.capabilities.capabilities.every((capability) => capability.first_received_at !== null)
  );
}

async function waitForReceipt(collectorOrigin, target) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const report = await reports(collectorOrigin, target);
    if (hasCompleteReceipt(report, target.environment)) return report;
    await new Promise((resolveWait) => globalThis.setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for the ${target.environment} telemetry receipt`);
}

async function driveCheckout(browser, target) {
  const page = await browser.newPage();
  let networkRequests = 0;
  page.on('request', () => {
    networkRequests += 1;
  });
  try {
    const response = await page.goto(target.origin);
    assert.equal(response?.ok(), true);
    await page.waitForFunction(() =>
      Boolean(globalThis.window.appHealth && globalThis.window.checkoutSample),
    );
    await page.waitForFunction(() =>
      globalThis.document.querySelector('#product')?.textContent?.includes('$84'),
    );
    await page.getByRole('button', { name: 'Complete checkout' }).click();
    await page.getByText('Checkout complete.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Simulate unavailable checkout' }).click();
    await page.getByText('Service unavailable (503).', { exact: true }).waitFor();
    const diagnostics = await page.evaluate(() => ({
      tracker: globalThis.window.appHealth?.diagnostics(),
      logger: globalThis.window.checkoutSample?.logger.diagnostics(),
    }));
    assert((diagnostics.tracker?.accepted ?? 0) >= 2, 'tracker sent a page view and named event');
    assert((diagnostics.logger?.sent ?? 0) >= 1, 'browser logger sent an explicit event');
    const [html, script] = await Promise.all([
      (await globalThis.fetch(target.origin)).text(),
      (await globalThis.fetch(`${target.origin}/assets/checkout.js`)).text(),
    ]);
    assert(html.includes(target.publicKey));
    assert(!html.includes(target.privateKey));
    assert(!script.includes(target.privateKey));
    return networkRequests;
  } finally {
    await page.close();
  }
}

function receiptCounts(report) {
  return {
    pageviews: report.analytics.series.reduce((total, point) => total + point.pageviews, 0),
    events: report.analytics.series.reduce((total, point) => total + point.events, 0),
    endpoints: report.endpoints.endpoints.reduce(
      (total, endpoint) => total + endpoint.request_count,
      0,
    ),
    logs: report.logs.logs.length,
    failures: report.failures.failures.length,
  };
}

let vite;
let browser;
let proxy;
const samples = [];
try {
  const bundle = await buildSample();
  vite = await createServer({
    root: join(projectRoot, 'apps/web'),
    configFile: join(projectRoot, 'apps/web/vite.config.ts'),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, open: false },
  });
  await vite.listen();
  const collectorOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  proxy = await startCollectorProxy(collectorOrigin);
  const ports = await Promise.all([availablePort(), availablePort(), availablePort()]);
  const origins = ports.map((port) => `http://127.0.0.1:${port}`);
  const targets = await createTargets(collectorOrigin, origins.slice(0, 2));
  assert.notEqual(targets[0].privateKey, targets[1].privateKey);
  assert.notEqual(targets[0].publicKey, targets[1].publicKey);
  for (const target of targets) {
    const sample = new Miniflare(sampleOptions(target, proxy.origin, bundle));
    samples.push(sample);
    assert.equal((await sample.ready).origin, target.origin);
  }
  const emptyStaging = await reports(collectorOrigin, targets[1]);
  assert.deepEqual(emptyStaging.endpoints.endpoints, []);
  assert.deepEqual(emptyStaging.logs.logs, []);
  assert(emptyStaging.capabilities.capabilities.every((item) => item.first_received_at === null));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  });
  const productionNetworkRequests = await driveCheckout(browser, targets[0]);
  const production = await waitForReceipt(collectorOrigin, targets[0]);
  const productionCounts = receiptCounts(production);
  assert.equal(
    productionCounts.pageviews,
    1,
    'one automatic pageview without duplicate navigation',
  );
  assert.equal(productionCounts.events, 1, 'one explicit checkout analytics event');
  const eventReport = await jsonRequest(
    collectorOrigin,
    `/v1/analytics/report?range=1h&app_id=${targets[0].appId}&environment_id=${targets[0].environmentId}&event=checkout.production.completed`,
  );
  assert.equal(
    eventReport.series.reduce((total, point) => total + point.events, 0),
    1,
  );
  assert.equal(
    eventReport.series.reduce((total, point) => total + point.pageviews, 0),
    0,
  );
  assert.deepEqual(eventReport.pages, [{ name: '/', count: 1 }]);
  const stagingBefore = await reports(collectorOrigin, targets[1]);
  assert(!hasCompleteReceipt(stagingBefore, targets[1].environment));
  const stagingNetworkRequests = await driveCheckout(browser, targets[1]);
  const stagingReport = await waitForReceipt(collectorOrigin, targets[1]);
  const productionAfter = await reports(collectorOrigin, targets[0]);
  assert.deepEqual(receiptCounts(productionAfter), productionCounts);
  assert(
    !productionAfter.analytics.events.some((event) => event.name.includes('.staging.')),
    'staging analytics stayed out of production',
  );
  assert(
    !productionAfter.logs.logs.some((entry) => entry.event.includes('.staging.')),
    'staging logs stayed out of production',
  );
  const unavailableTarget = { ...targets[0], origin: origins[2] };
  const unavailableSample = new Miniflare(
    sampleOptions(unavailableTarget, 'http://127.0.0.1:1', bundle),
  );
  samples.push(unavailableSample);
  await unavailableSample.ready;
  const unavailableCollectorResponses = {
    product: (
      await unavailableSample.dispatchFetch(`${unavailableTarget.origin}/api/products/trail-pack`)
    ).status,
    checkout: (
      await unavailableSample.dispatchFetch(`${unavailableTarget.origin}/api/checkout`, {
        method: 'POST',
      })
    ).status,
  };
  assert.deepEqual(unavailableCollectorResponses, { product: 200, checkout: 201 });
  const unavailableEndpoint = production.endpoints.endpoints.find(
    (endpoint) => endpoint.route === '/api/checkout/unavailable',
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'local-cloudflare-sample',
        production: productionCounts,
        staging: receiptCounts(stagingReport),
        browserNetworkRequests: {
          production: productionNetworkRequests,
          staging: stagingNetworkRequests,
        },
        telemetryTransport: proxy.stats,
        assetSizes: bundle.assetSizes,
        failureProof: {
          route: unavailableEndpoint.route,
          status: 503,
          errorRate: unavailableEndpoint.error_rate,
        },
        unavailableCollectorResponses,
        compatibilityDate: COMPATIBILITY_DATE,
        capabilities: ['analytics', 'endpoints', 'logs'],
        privateKeysExposedToBrowser: false,
        environmentIsolation: true,
        productResponsesSurviveCollectorFailure: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser?.close();
  await Promise.all(samples.map((sample) => sample.dispose()));
  if (proxy)
    await new Promise((resolveClosed, reject) =>
      proxy.server.close((error) => (error ? reject(error) : resolveClosed())),
    );
  await vite?.close();
  await rm(scratch, { recursive: true, force: true });
}
