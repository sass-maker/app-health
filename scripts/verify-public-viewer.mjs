import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer as httpServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { log } from 'node:console';
import process from 'node:process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const { createServer, build } = await import(webRequire.resolve('vite'));
const playwright = await import(webRequire.resolve('@playwright/test'));
const { chromium } = playwright.default ?? playwright;
const output = await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    lib: {
      entry: join(root, 'packages/node/src/viewer.ts'),
      formats: ['iife'],
      name: 'AppHealthViewer',
    },
  },
});
const bundle = (Array.isArray(output) ? output[0] : output).output.find(
  (item) => item.type === 'chunk' && item.isEntry,
).code;
const vite = await createServer({
  root: join(root, 'apps/web'),
  configFile: join(root, 'apps/web/vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, open: false },
});
let browser;
let host;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function api(path, method = 'GET', body, headers = {}) {
    const response = await globalThis.fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert(response.ok, `${path}: ${response.status}`);
    return response.json();
  }
  const project = await api('/v1/apps', 'POST', {
    name: 'Public viewer canary',
    environment: 'production',
  });
  const scope = `app_id=${project.app.id}&environment_id=${project.environment.id}`;
  const publicKey = await api('/v1/public-keys', 'POST', {
    app_id: project.app.id,
    environment_id: project.environment.id,
    allowed_origins: ['https://sample.test'],
  });
  await api(
    '/v1/browser',
    'POST',
    {
      schema_version: 1,
      public_key: publicKey.key,
      batch_id: randomUUID(),
      session_id: randomUUID(),
      events: [
        {
          event_id: randomUUID(),
          timestamp: Date.now(),
          type: 'pageview',
          path: '/private-checkout',
        },
      ],
    },
    { origin: 'https://sample.test' },
  );
  const sharing = await api(`/v1/analytics/shares?${scope}`, 'POST');
  host = httpServer((request, response) => {
    if (request.url === '/viewer.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end(bundle);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(
      '<!doctype html><title>Product analytics sample</title><body><h1>Product analytics</h1><output id="live">Loading</output><script src="/viewer.js"></script></body>',
    );
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const productOrigin = `http://127.0.0.1:${host.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CI ? {} : { channel: 'chrome' }),
  });
  const page = await browser.newPage();
  const reads = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/shared/analytics')) reads.push(request);
  });
  await page.goto(productOrigin);
  await page.evaluate(
    ({ origin, token }) => {
      globalThis.window.viewer = globalThis.window.AppHealthViewer.createAnalyticsViewer({
        origin,
        token,
      });
      globalThis.window.states = [];
      globalThis.window.viewer.subscribe((state) => {
        globalThis.window.states.push(state);
        globalThis.document.querySelector('#live').textContent =
          state.kind === 'ready'
            ? `${state.data.live.active} live · ${state.data.traffic.pageviews} pageviews`
            : state.kind;
      });
    },
    { origin, token: sharing.token },
  );
  await page.getByText('1 live · 1 pageviews').waitFor();
  assert.notEqual(new globalThis.URL(page.url()).origin, origin);
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify(globalThis.window.states).includes('/private-checkout'),
    ),
    false,
  );
  assert.equal(await reads[0].headerValue('cookie'), null);
  assert.equal(await reads[0].headerValue('authorization'), `Bearer ${sharing.token}`);
  await api(`/v1/analytics/shares?${scope}&id=${sharing.share.id}`, 'DELETE');
  await page.evaluate(async () => {
    try {
      await globalThis.window.viewer.read();
    } catch {
      /* Expected revoked link. */
    }
  });
  await page.getByText('unavailable', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.window.states.at(-1).reason), 'revoked');
  await page.evaluate(() => globalThis.window.viewer.close());
  const evidence = join(root, '.fleet/evidence/public-analytics');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'viewer-sdk-revoked.png') });
  log(
    'Public viewer browser: real cross-origin preflight/read, aggregate-only data, no cookies, and immediate revoked-state clearing verified.',
  );
} finally {
  await browser?.close();
  if (host) await new Promise((resolve) => host.close(resolve));
  await vite.close();
}
