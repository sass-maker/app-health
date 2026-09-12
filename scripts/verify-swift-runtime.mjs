import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { log } from 'node:console';

// Build packages/swift with XcodeBuildMCP first. This canary executes that local
// binary against the actual collector, with ephemeral data and public keys only.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const { createServer } = await import(webRequire.resolve('vite'));
const run = promisify(execFile);
const vite = await createServer({
  root: join(root, 'apps/web'),
  configFile: join(root, 'apps/web/vite.config.ts'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, open: false },
});
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  async function request(path, method = 'GET', body) {
    const response = await globalThis.fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(8000),
    });
    assert(response.ok, `${method} ${path}: ${response.status}`);
    return response.json();
  }
  const project = await request('/v1/apps', 'POST', {
    name: 'Swift integration canary',
    environment: 'production',
  });
  const query = `app_id=${project.app.id}&environment_id=${project.environment.id}`;
  const native = await request(`/v1/native-keys?${query}`, 'POST');
  const binary = join(root, 'packages/swift/.build/debug/AppHealthCanary');
  const accepted = await run(binary, [origin, native.key], { timeout: 15000 });
  assert.match(accepted.stdout, /accepted=2 dropped=0 retries=0 queued=0/);
  const report = await request(`/v1/analytics/report?range=1h&${query}`);
  assert.deepEqual(
    report.events.map(({ name, count }) => ({ name, count })),
    [{ name: 'swift.canary', count: 1 }],
  );
  assert.equal(
    report.series.reduce((sum, point) => sum + point.pageviews, 0),
    0,
  );
  const logs = await request(`/v1/logs?${query}&source=native`);
  assert.equal(logs.logs.length, 1);
  assert.equal(logs.logs[0].event, 'swift.canary');
  assert.deepEqual(logs.logs[0].props, { platform: 'swift' });
  const capabilities = await request(`/v1/capabilities?${query}`);
  for (const id of ['logs', 'analytics']) {
    assert.notEqual(
      capabilities.capabilities.find((item) => item.id === id)?.first_received_at ?? null,
      null,
    );
  }
  await request(`/v1/native-keys?${query}&id=${native.record.id}`, 'DELETE');
  const rejected = await run(binary, [origin, native.key], { timeout: 15000 });
  assert.match(rejected.stdout, /accepted=0 dropped=2 retries=0 queued=0/);
  assert.equal((await request(`/v1/logs?${query}&source=native`)).logs.length, 1);
  log(
    'Swift native HTTP: events, logs, diagnostics, project scope, no fabricated pageviews, and revoked-key rejection verified.',
  );
} finally {
  await vite.close();
}
