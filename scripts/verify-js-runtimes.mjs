import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeEntry = pathToFileURL(join(root, 'packages/node/dist/index.js')).href;
const webEntry = pathToFileURL(join(root, 'packages/node/dist/web.js')).href;
const privateKey = 'runtime-canary-private-key';
const publicKey = 'ahk_pub_runtime_canary';

await access(join(root, 'packages/node/dist/index.js'));
await access(join(root, 'packages/node/dist/web.js'));

const requests = [];
const retryBodies = new Map();
const attempts = new Map();
const server = createServer(async (request, response) => {
  const body = await readBody(request);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return finish(response, 400, { error: 'invalid JSON' });
  }
  const isIngest = request.url === '/v1/ingest';
  const isLogs = request.url === '/v1/logs';
  if (!isIngest && !isLogs) return finish(response, 404, { error: 'unknown path' });
  const kind = isIngest ? 'endpoint' : 'server-log';
  const isBrowserLog = isLogs && typeof parsed.public_key === 'string';
  const runtime = parsed.environment ?? 'server';
  const key = `${runtime}:${kind}:${parsed.batch_id}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  requests.push({ path: request.url, headers: request.headers, body: parsed, kind, attempt });
  if (isIngest) {
    if (request.headers.authorization !== `Bearer ${privateKey}`)
      return finish(response, 401, { error: 'server authorization missing' });
    if (
      parsed.schema_version !== 'v1' ||
      !Array.isArray(parsed.events) ||
      parsed.events.length !== 1
    )
      return finish(response, 422, { error: 'invalid endpoint batch' });
    const event = parsed.events[0];
    if (event.method !== 'GET' || event.route !== '/runtime-canary' || event.status_code !== 200)
      return finish(response, 422, { error: 'invalid endpoint event' });
  } else {
    if (parsed.schema_version !== 'v1' || !Array.isArray(parsed.logs) || parsed.logs.length !== 1)
      return finish(response, 422, { error: 'invalid log batch' });
    const log = parsed.logs[0];
    if (log.event !== 'runtime.canary')
      return finish(response, 422, { error: 'invalid log event' });
    if (isBrowserLog && request.headers.authorization)
      return finish(response, 422, { error: 'browser sent private authorization' });
    if (!isBrowserLog && request.headers.authorization !== `Bearer ${privateKey}`)
      return finish(response, 401, { error: 'server authorization missing' });
  }
  if (attempt === 1 && !isBrowserLog) {
    retryBodies.set(key, body);
    return finish(response, 503, { error: 'transient canary failure' });
  }
  if (retryBodies.has(key) && retryBodies.get(key) !== body)
    return finish(response, 422, { error: 'retry changed batch body' });
  return finish(response, 202, { accepted: true });
});

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function finish(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

await once(server.listen(0, '127.0.0.1'), 'listening');
const port = server.address().port;
const temp = await mkdtemp(join(tmpdir(), 'app-health-js-runtimes-'));
const child = join(temp, 'canary.mjs');
await writeFile(
  child,
  `const core = await import(${JSON.stringify(nodeEntry)});
const web = await import(${JSON.stringify(webEntry)});
const args = typeof Deno !== 'undefined' ? Deno.args : process.argv.slice(2);
const runtime = args[0];
const endpoint = args[1];
const client = core.createAppHealthClient({
  key: ${JSON.stringify(privateKey)}, endpoint: endpoint + '/v1/ingest', logsEndpoint: endpoint + '/v1/logs',
  runtime: 'node', environment: runtime, maxBatchSize: 10, maxRetries: 2, retryBackoffMs: 1, requestTimeoutMs: 1000,
  disableTimer: true,
});
client.record({ method: 'GET', route: '/runtime-canary', status_code: 200, duration_ms: 3 });
client.log('runtime.canary', { props: { runtime } });
await client.close();
const logger = web.createWebLogger({
  publicKey: ${JSON.stringify(publicKey)}, endpoint: endpoint + '/v1/logs', environment: runtime, lifecycle: false,
  disableTimer: true,
});
logger.log('runtime.canary', { props: { runtime } });
await logger.flush();
if (client.diagnostics().sentBatches !== 2 || client.diagnostics().sentEvents !== 2 || logger.diagnostics().sent !== 1) throw new Error('delivery diagnostics failed: ' + JSON.stringify({ client: client.diagnostics(), logger: logger.diagnostics() }));
console.log(JSON.stringify({ runtime, version: typeof Bun !== 'undefined' ? Bun.version : typeof Deno !== 'undefined' ? Deno.version.deno : process.version }));`,
);

const results = [];
try {
  const runtimes = [
    { name: 'node', command: process.execPath, args: [child] },
    { name: 'bun', command: 'bun', args: [child] },
    {
      name: 'deno',
      command: 'deno',
      args: ['run', '--allow-net', '--allow-read', child],
    },
  ];
  for (const runtime of runtimes) {
    const output = await run(runtime.command, runtime.args, {
      canaryArgs: [runtime.name, `http://127.0.0.1:${port}`],
    });
    results.push({ ...runtime, output: output.trim() });
  }
  for (const runtime of runtimes) {
    const endpoint = requests.filter(
      (request) => request.kind === 'endpoint' && request.body.environment === runtime.name,
    );
    if (endpoint.length !== 2 || endpoint[0].body.batch_id !== endpoint[1].body.batch_id)
      throw new Error(`${runtime.name} endpoint retry missing or changed batch`);
  }
  const endpointRequests = requests.filter((request) => request.kind === 'endpoint');
  const serverLogs = requests.filter((request) => request.kind === 'server-log');
  const browserLogs = serverLogs.filter((request) => request.body.public_key === publicKey);
  if (endpointRequests.length !== 6 || serverLogs.length !== 9 || browserLogs.length !== 3)
    throw new Error('unexpected request counts');
  console.log(JSON.stringify({ ok: true, results, requests: requests.length, retries: 6 }));
} finally {
  server.close();
  await rm(temp, { recursive: true, force: true });
}

function run(command, args, extraEnv) {
  return new Promise((resolveRun, reject) => {
    const processHandle = spawn(command, [...args, ...(extraEnv.canaryArgs ?? [])], {
      cwd: root,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    processHandle.stdout.on('data', (chunk) => (stdout += chunk));
    processHandle.stderr.on('data', (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => processHandle.kill('SIGTERM'), 20_000);
    processHandle.once('error', reject);
    processHandle.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0)
        reject(new Error(`${command} failed (${code ?? signal}): ${stderr || stdout}`));
      else resolveRun(stdout);
    });
  });
}
