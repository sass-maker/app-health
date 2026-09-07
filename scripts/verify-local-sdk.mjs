import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createAppHealthClient } from '../packages/node/dist/index.js';
import { expressMiddleware } from '../packages/node/dist/express.js';

const webRequire = createRequire(new globalThis.URL('../apps/web/package.json', import.meta.url));
const nodeRequire = createRequire(
  new globalThis.URL('../packages/node/package.json', import.meta.url),
);
const { createServer } = await import(webRequire.resolve('vite'));
const express = nodeRequire('express');
const root = fileURLToPath(new globalThis.URL('../apps/web', import.meta.url));
const vite = await createServer({ root, server: { host: '127.0.0.1', port: 0, open: false } });
let service;
let client;
try {
  await vite.listen();
  const api = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const createdResponse = await globalThis.fetch(`${api}/v1/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'synthetic-sdk-verification', environment: 'local' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const query = new globalThis.URLSearchParams({
    app_id: created.app.id,
    environment_id: created.environment.id,
    window: '15m',
  });
  async function read(path) {
    const response = await globalThis.fetch(`${api}/v1/${path}?${query}`);
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal((await read('installation/status')).state, 'waiting');
  assert.deepEqual((await read('endpoints')).endpoints, []);
  client = createAppHealthClient({
    key: created.key.key,
    environment: 'local',
    endpoint: `${api}/v1/ingest`,
    disableTimer: true,
  });
  const app = express();
  app.use(expressMiddleware({ client }));
  app.get('/synthetic/:id', (request, response) =>
    response.sendStatus(request.params.id === 'failure' ? 503 : 200),
  );
  service = app.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const origin = `http://127.0.0.1:${service.address().port}`;
  for (const [id, status] of [
    ['private-one', 200],
    ['private-two', 200],
    ['failure', 503],
  ]) {
    const response = await globalThis.fetch(`${origin}/synthetic/${id}?private=not-collected`);
    assert.equal(response.status, status);
    await response.text();
  }
  await client.flush();
  const installation = await read('installation/status');
  assert.equal(installation.state, 'connected');
  assert.equal(installation.runtime, 'node');
  const result = await read('endpoints');
  assert.equal(result.endpoints.length, 1);
  const aggregate = result.endpoints[0];
  assert.equal(aggregate.method, 'GET');
  assert.equal(aggregate.route, '/synthetic/:id');
  assert.equal(aggregate.request_count, 3);
  assert.equal(aggregate.error_count, 1);
  assert.equal(aggregate.error_rate, 1 / 3);
  assert.ok(Number.isFinite(aggregate.p50_ms) && aggregate.p50_ms >= 0);
  assert.ok(Number.isFinite(aggregate.p95_ms) && aggregate.p95_ms >= aggregate.p50_ms);
  assert.ok(!JSON.stringify(result).includes('private-one'));
  assert.ok(!JSON.stringify(result).includes('not-collected'));
  globalThis.console.log(
    JSON.stringify(
      { mode: 'local-synthetic-sdk', installation: installation.state, aggregate },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  if (service)
    await new Promise((resolve, reject) =>
      service.close((error) => (error ? reject(error) : resolve())),
    );
  await vite.close();
}
