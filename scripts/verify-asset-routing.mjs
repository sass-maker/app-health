import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { log } from 'node:console';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptsRoot);
const productionConfig = await readFile(join(projectRoot, 'apps/worker/wrangler.jsonc'), 'utf8');
const routingMatch = productionConfig.match(/"run_worker_first"\s*:\s*\[([^\]]+)\]/s);
assert(routingMatch, 'production assets routing is missing');
const runWorkerFirst = [...routingMatch[1].matchAll(/"([^"\\]+)"/g)].map((match) => match[1]);
assert(runWorkerFirst.includes('/v1/*'));
assert(runWorkerFirst.includes('/live'));
const scratch = await mkdtemp(join(tmpdir(), 'app-health-assets-'));
const config = join(scratch, 'wrangler.jsonc');
await writeFile(
  config,
  JSON.stringify({
    name: 'app-health-assets-routing-check',
    main: join(projectRoot, 'apps/worker/src/analytics-entry.ts'),
    compatibility_date: '2026-07-22',
    compatibility_flags: ['nodejs_compat'],
    assets: {
      directory: join(projectRoot, 'apps/web/dist'),
      binding: 'ASSETS',
      run_worker_first: runWorkerFirst,
      not_found_handling: 'single-page-application',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'assets-routing-check',
        database_id: '00000000-0000-0000-0000-000000000001',
        migrations_dir: join(projectRoot, 'apps/worker/migrations'),
      },
    ],
    vars: {
      APP_HEALTH_MODE: 'local',
      APP_HEALTH_ACCOUNTS: 'enabled',
      APP_HEALTH_DASHBOARD_HOST: '127.0.0.1',
      GOOGLE_CLIENT_ID: 'synthetic-client',
      GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
      BETTER_AUTH_SECRET: 'synthetic-local-secret-at-least-32-characters',
    },
  }),
  'utf8',
);

const child = spawn(
  'pnpm',
  [
    '--filter',
    '@app-health/worker',
    'exec',
    'wrangler',
    'dev',
    '--local',
    '--config',
    config,
    '--port',
    '8794',
  ],
  {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output = `${output}${chunk.toString()}`.slice(-64 * 1024);
});
child.stderr.on('data', (chunk) => {
  output = `${output}${chunk.toString()}`.slice(-64 * 1024);
});
const origin = 'http://127.0.0.1:8794';
async function waitForWorker() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await globalThis.fetch(`${origin}/`);
      if (response.status > 0) return;
    } catch {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
  }
  throw new Error(`asset routing worker did not start\n${output}`);
}

try {
  await waitForWorker();
  const navigate = { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } };
  const callback = await globalThis.fetch(
    `${origin}/v1/auth/callback/google?code=invalid&state=invalid`,
    navigate,
  );
  assert.notEqual(callback.headers.get('content-type')?.split(';')[0], 'text/html');
  assert.equal((await callback.text()).includes('<div id="root">'), false);
  const live = await globalThis.fetch(`${origin}/live`, { ...navigate, redirect: 'manual' });
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(live.headers.get('x-frame-options'), null);
  const liveHtml = await live.text();
  const liveAsset = liveHtml.match(/src="(\/assets\/live-[^"]+\.js)"/)?.[1];
  assert(liveAsset, 'live page must reference the live bundle');
  assert.equal(liveHtml.includes('/assets/main-'), false);
  assert.equal((await globalThis.fetch(`${origin}${liveAsset}`)).status, 200);
  const spa = await globalThis.fetch(`${origin}/projects/unknown`, navigate);
  assert.equal(spa.status, 200);
  assert.equal(spa.headers.get('content-type')?.split(';')[0], 'text/html');
  assert.match(await spa.text(), /<div id="root">/);
  log('Asset routing: callback, /live, and ordinary SPA navigation verified.');
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
