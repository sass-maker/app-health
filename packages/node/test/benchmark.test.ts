import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import express from 'express';
import request from 'supertest';
import { createAppHealthClient } from '../src/index.js';
import { expressMiddleware } from '../src/express.js';

// Small overhead benchmark: measures the per-request overhead added by the
// middleware when delivery is asynchronous and non-blocking. Asserts a loose
// budget so the test stays stable across machines while still catching
// regressions that make ingest synchronous or expensive.

const WARMUP = 50;
const ITERATIONS = 300;

async function timeRequests(app: express.Express, n: number): Promise<number> {
  // Keep one listener for the run: recycling an ephemeral listener on every
  // request can race pooled sockets and measures server setup, not middleware.
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const t0 = performance.now();
    for (let i = 0; i < n; i += 1) {
      await request(server).get('/health').expect(200);
    }
    return performance.now() - t0;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('middleware overhead benchmark', () => {
  // Benchmark is long; allow up to 60s per test.
  it('adds bounded per-request overhead versus no middleware', { timeout: 60_000 }, async () => {
    // Baseline: plain Express app, no middleware.
    const bareApp = express();
    bareApp.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    // Instrumented: middleware with a no-op-ish client (instant 202 fetch).
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: async () => new Response('{}', { status: 202 }),
      disableTimer: true,
      maxBatchSize: 1000,
      maxQueueSize: 100_000,
    });
    const instrApp = express();
    instrApp.use(expressMiddleware({ client }));
    instrApp.get('/health', (_req, res) => res.status(200).json({ ok: true }));

    // Warm up both apps so JIT and connection setup are amortized.
    await timeRequests(bareApp, WARMUP);
    await timeRequests(instrApp, WARMUP);

    const bareMs = await timeRequests(bareApp, ITERATIONS);
    const instrMs = await timeRequests(instrApp, ITERATIONS);
    await client.close();

    const perRequestOverheadUs = ((instrMs - bareMs) / ITERATIONS) * 1000;
    console.log(
      `[benchmark] bare=${(bareMs / ITERATIONS).toFixed(3)}ms/req ` +
        `instrumented=${(instrMs / ITERATIONS).toFixed(3)}ms/req ` +
        `overhead=${perRequestOverheadUs.toFixed(1)}us/req ` +
        `(${ITERATIONS} iterations)`,
    );
    // The middleware must add well under 1ms per request. The budget is loose
    // enough for CI runners but catches synchronous-delivery regressions.
    expect(perRequestOverheadUs).toBeLessThan(1000);
  });
});
