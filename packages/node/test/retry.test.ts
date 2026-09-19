import { describe, expect, it } from 'vitest';
import { createAppHealthClient } from '../src/index.js';
import { createFetchController } from './helpers.js';

describe('client retry and outage behavior', () => {
  it('releases the unused response body after delivery', async () => {
    const response = new Response('collector receipt', { status: 202 });
    const client = createAppHealthClient({
      key: 'test',
      endpoint: 'http://localhost/v1/ingest',
      disableTimer: true,
      fetch: async () => response,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.close();
    expect(response.bodyUsed).toBe(true);
    expect(client.diagnostics().sentEvents).toBe(1);
  });
  it('retries transient 5xx responses up to maxRetries, then succeeds', async () => {
    const controller = createFetchController();
    controller.setResponses([{ status: 503 }, { status: 503 }, { ok: true, status: 202 }]);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxRetries: 3,
      retryBackoffMs: 1,
      maxBatchSize: 10,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.flush();
    expect(controller.callCount()).toBe(3);
    expect(client.diagnostics().sentBatches).toBe(1);
    expect(client.diagnostics().retriedBatches).toBe(1);
  });

  it('does not retry non-retryable 4xx responses', async () => {
    const controller = createFetchController();
    controller.setResponses([{ status: 403 }]);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxRetries: 3,
      retryBackoffMs: 1,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.flush();
    expect(controller.callCount()).toBe(1);
    expect(client.diagnostics().failedBatches).toBe(1);
    expect(client.diagnostics().lastSendError).toMatch(/403/);
  });

  it('retries 429 (rate limited) as a transient status', async () => {
    const controller = createFetchController();
    controller.setResponses([{ status: 429 }, { ok: true, status: 202 }]);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.flush();
    expect(controller.callCount()).toBe(2);
    expect(client.diagnostics().sentBatches).toBe(1);
  });

  it('replays retries with one stable batch_id so collector dedupe absorbs them', async () => {
    const controller = createFetchController();
    controller.setResponses([
      { status: 503 },
      { ok: true, status: 202 },
      { status: 503 },
      { ok: true, status: 202 },
    ]);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    client.log('synthetic.event', { title: 'synthetic' });
    await client.flush();
    expect(controller.callCount()).toBe(4);
    const batchIds = controller.requests.map((r) => JSON.parse(r.body).batch_id as string);
    // Requests 0-1 are the endpoint batch attempts; 2-3 the log batch attempts.
    expect(new Set(batchIds.slice(0, 2)).size).toBe(1);
    expect(new Set(batchIds.slice(2)).size).toBe(1);
    expect(batchIds[0]).not.toBe(batchIds[2]);
    // The replayed body is byte-identical, not just id-stable.
    expect(controller.requests[0].body).toBe(controller.requests[1].body);
    expect(controller.requests[2].body).toBe(controller.requests[3].body);
    expect(controller.requests[0].url).toBe('http://localhost:8787/v1/ingest');
    expect(controller.requests[2].url).toBe('http://localhost:8787/v1/logs');
  });

  it('retries network errors (fetch throws) and eventually fails closed', async () => {
    const controller = createFetchController();
    controller.setResponses([{ throw: 'connect ECONNREFUSED' }, { throw: 'timeout' }]);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxRetries: 1,
      retryBackoffMs: 1,
      maxQueueSize: 100,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.flush();
    expect(controller.callCount()).toBe(2);
    const d = client.diagnostics();
    expect(d.failedBatches).toBe(1);
    expect(d.droppedDelivery).toBe(1);
    expect(d.lastSendError).toMatch(/ECONNREFUSED|timeout/);
  });

  it('fails open: ingest outage never throws and never blocks record()', async () => {
    const throwingFetch = async () => {
      throw new Error('network down');
    };
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: throwingFetch,
      disableTimer: true,
      maxRetries: 0,
      maxQueueSize: 50,
    });
    // record() must not throw even when delivery will fail.
    for (let i = 0; i < 60; i += 1) {
      client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    }
    await client.flush();
    const d = client.diagnostics();
    expect(d.failedBatches).toBeGreaterThan(0);
    // Overflow drops occurred because the queue (50) could not hold 60 events
    // while delivery was failing.
    expect(d.droppedOverflow).toBeGreaterThan(0);
  });

  it('sends the ingest key as a bearer token and the v1 schema version', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test_secret',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      release: 'v1.0.0',
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.flush();
    expect(controller.requests[0].headers.authorization).toBe('Bearer ahk_test_secret');
    const body = JSON.parse(controller.requests[0].body);
    expect(body.schema_version).toBe('v1');
    expect(body.runtime).toBe('node');
    expect(body.release).toBe('v1.0.0');
  });
});
