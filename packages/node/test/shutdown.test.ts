import { describe, expect, it } from 'vitest';
import { createAppHealthClient } from '../src/index.js';
import { createFetchController } from './helpers.js';

describe('client flush, close, and timer shutdown', () => {
  it('flush() drains the queue and resolves', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
      maxBatchSize: 100,
    });
    for (let i = 0; i < 5; i += 1) {
      client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    }
    await client.flush();
    expect(client.diagnostics().queued).toBe(0);
    expect(controller.requests).toHaveLength(1);
  });

  it('close() flushes remaining events and stops further recording', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    client.record({ method: 'POST', route: '/orders', status_code: 201, duration_ms: 2 });
    await client.close();
    expect(controller.requests).toHaveLength(1);
    expect(client.diagnostics().sentEvents).toBe(2);
    // After close, record() is a no-op.
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    expect(client.diagnostics().queued).toBe(0);
  });

  it('close() drains events while the automatic timer is enabled', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    await client.close();
    expect(controller.requests).toHaveLength(1);
    expect(client.diagnostics().sentEvents).toBe(1);
    expect(client.diagnostics().queued).toBe(0);
  });

  it('close() is idempotent', async () => {
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      disableTimer: true,
    });
    await client.close();
    await client.close();
  });

  it('coalesces concurrent close calls until the shared flush completes', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: async () => {
        await blocked;
        return new Response('{}', { status: 202 });
      },
      disableTimer: true,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    const first = client.close();
    const second = client.close();
    expect(second).toBe(first);
    let completed = false;
    void second.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(client.diagnostics().sentEvents).toBe(1);
  });

  it('auto-flush timer fires on the configured interval', async () => {
    const controller = createFetchController();
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      flushIntervalMs: 10,
      maxBatchSize: 100,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    // Wait long enough for at least one timer-driven flush.
    await new Promise((r) => setTimeout(r, 40));
    expect(controller.requests.length).toBeGreaterThanOrEqual(1);
    await client.close();
  });

  it('coalesces concurrent flush calls into a single drain', async () => {
    let resolveFirst: () => void;
    const block = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let calls = 0;
    const slowFetch = async () => {
      calls += 1;
      if (calls === 1) await block;
      return new Response('{}', { status: 202 });
    };
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: slowFetch,
      disableTimer: true,
      maxBatchSize: 100,
    });
    client.record({ method: 'GET', route: '/health', status_code: 200, duration_ms: 1 });
    const p1 = client.flush();
    const p2 = client.flush();
    expect(p2).toBe(p1);
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolveFirst!();
    await Promise.all([p1, p2, closing]);
    expect(closed).toBe(true);
    expect(calls).toBe(1);
  });
});
