import { describe, expect, it } from 'vitest';
import { createAppHealthClient } from '../src/index.js';
import { createFetchController } from './helpers.js';

describe('client batching and overflow', () => {
  it('splits high-cardinality endpoint batches below provider capacity', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'test',
      endpoint: 'http://localhost/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxBatchSize: 1000,
    });
    for (let i = 0; i < 251; i++)
      client.record({ method: 'GET', route: `/route-${i}`, status_code: 200, duration_ms: 1 });
    await client.close();
    expect(controller.requests.map((request) => JSON.parse(request.body).events.length)).toEqual([
      250, 1,
    ]);
    expect(client.diagnostics().sentEvents).toBe(251);
  });
  it('splits valid large Unicode logs below the collector byte limit without losing entries', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'test',
      endpoint: 'http://localhost/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
    });
    const props = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`field${i}`, '🚀'.repeat(250)]),
    );
    for (let i = 0; i < 50; i++) client.log('payload.test', { props });
    await client.close();
    expect(controller.requests.length).toBeGreaterThan(1);
    expect(
      controller.requests.every((request) => Buffer.byteLength(request.body) <= 256 * 1024),
    ).toBe(true);
    expect(
      controller.requests.reduce((sum, request) => sum + JSON.parse(request.body).logs.length, 0),
    ).toBe(50);
    expect(client.diagnostics().sentEvents).toBe(50);
  });
  it('batches events up to maxBatchSize and sends one batch per flush', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxBatchSize: 3,
    });
    for (let i = 0; i < 7; i += 1) {
      client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    }
    await client.flush();
    // 7 events / 3 per batch = 3 batches (3 + 3 + 1).
    expect(controller.requests).toHaveLength(3);
    const sizes = controller.requests.map((r) => JSON.parse(r.body).events.length);
    expect(sizes).toEqual([3, 3, 1]);
    const d = client.diagnostics();
    expect(d.sentBatches).toBe(3);
    expect(d.sentEvents).toBe(7);
    expect(d.queued).toBe(0);
  });

  it('drops events when the queue is full and increments droppedOverflow', async () => {
    const controller = createFetchController(500);
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxQueueSize: 4,
      maxBatchSize: 2,
      maxRetries: 0,
    });
    // Fill the queue beyond capacity without flushing (size threshold = 2,
    // so record() will trigger flushes). To force overflow deterministically,
    // block delivery with 500s and a tiny queue.
    for (let i = 0; i < 10; i += 1) {
      client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    }
    await client.flush();
    const d = client.diagnostics();
    expect(d.droppedOverflow).toBeGreaterThan(0);
    expect(d.failedBatches).toBeGreaterThan(0);
  });

  it('drops invalid events and increments droppedInvalid', () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
    });
    client.record({ method: 'G3T', route: '/health', status_code: 200, duration_ms: 1 });
    client.record({ method: 'GET', route: 'no-slash', status_code: 200, duration_ms: 1 });
    client.record({ method: 'GET', route: '/health', status_code: 99, duration_ms: 1 });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 999_999_999 });
    expect(() => client.record(null as never)).not.toThrow();
    expect(() => client.log('bad.input', null as never)).not.toThrow();
    expect(client.diagnostics().droppedInvalid).toBe(6);
    expect(client.diagnostics().queued).toBe(0);
  });

  it('auto-flushes when the queue reaches maxBatchSize', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxBatchSize: 2,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    // Allow the triggered async flush to complete.
    await new Promise((r) => setTimeout(r, 5));
    expect(controller.requests).toHaveLength(1);
    await client.close();
  });

  it('rejects construction with invalid key or endpoint', () => {
    expect(() =>
      createAppHealthClient({ key: '', endpoint: 'http://localhost/v1/ingest' }),
    ).toThrowError(/non-empty `key`/);
    expect(() =>
      createAppHealthClient({ key: 'k', endpoint: 'ftp://localhost/v1/ingest' }),
    ).toThrowError(/http\(s\) `endpoint`/);
    expect(() =>
      createAppHealthClient({ key: 'k', endpoint: 'https://user:secret@example.com/v1/ingest' }),
    ).toThrowError(/http\(s\) `endpoint`/);
  });

  it('rejects invalid queue, batch, timeout, and retry bounds', () => {
    const endpoint = 'http://localhost:8787/v1/ingest';
    expect(() => createAppHealthClient({ key: 'k', endpoint, maxBatchSize: 0 })).toThrow(
      /maxBatchSize/,
    );
    expect(() => createAppHealthClient({ key: 'k', endpoint, maxQueueSize: 0 })).toThrow(
      /maxQueueSize/,
    );
    expect(() => createAppHealthClient({ key: 'k', endpoint, requestTimeoutMs: 0 })).toThrow(
      /requestTimeoutMs/,
    );
    expect(() => createAppHealthClient({ key: 'k', endpoint, maxRetries: -1 })).toThrow(
      /maxRetries/,
    );
  });
});
