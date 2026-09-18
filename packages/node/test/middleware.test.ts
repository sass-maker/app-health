import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAppHealthClient } from '../src/index.js';
import { expressMiddleware } from '../src/express.js';
import { createFetchController } from './helpers.js';

function setup() {
  const controller = createFetchController();
  const recorded: {
    method: string;
    route: string;
    status_code: number;
    duration_ms: number;
    response_bytes?: number;
  }[] = [];
  const client = createAppHealthClient({
    key: 'ahk_test',
    endpoint: 'http://localhost:8787/v1/ingest',
    fetch: controller.fetch,
    disableTimer: true,
    maxBatchSize: 100,
  });
  const app = express();
  app.use(express.json());
  app.use(
    expressMiddleware({
      client,
      onRecord: (e) => recorded.push(e),
    }),
  );
  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
  app.get('/users/:id', (req, res) => {
    if (req.params.id === 'missing') return res.status(404).json({ error: 'not found' });
    res.status(200).json({ id: req.params.id });
  });
  app.post('/orders', (req, res) => res.status(201).json({ ok: true, body: req.body }));
  app.get('/orders/:id/items/:itemId', (req, res) =>
    res.status(200).json({ id: req.params.id, itemId: req.params.itemId }),
  );
  app.get('/boom', () => {
    throw new Error('boom');
  });
  app.use(
    (_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: 'server error' });
    },
  );
  app.use((_req, res) => res.status(404).json({ error: 'not found' }));
  return { app, client, controller, recorded };
}

describe('expressMiddleware behavior', () => {
  it('emits a normalized template for parametric routes', async () => {
    const { app, client, recorded } = setup();
    await request(app).get('/users/123');
    await request(app).get('/users/456');
    await client.flush();
    expect(recorded.map((r) => r.route)).toEqual(['/users/:id', '/users/:id']);
    expect(recorded.every((r) => r.method === 'GET')).toBe(true);
  });

  it('records nested parametric templates verbatim from Express', async () => {
    const { app, client, recorded } = setup();
    await request(app).get('/orders/42/items/7');
    await client.flush();
    // Express preserves named params (`:itemId`) — the framework-native
    // template is preferred over the conservative :id fallback.
    expect(recorded[0].route).toBe('/orders/:id/items/:itemId');
  });

  it('records status code from matched responses and drops unmatched concrete paths', async () => {
    const { app, client, recorded } = setup();
    await request(app).get('/users/missing'); // 404
    await request(app).get('/boom'); // 500
    await request(app).get('/nope'); // 404 (unmatched)
    await client.flush();
    const statuses = recorded.map((r) => r.status_code).sort((a, b) => a - b);
    expect(statuses).toEqual([404, 500]);
    expect(recorded.map((r) => r.route)).not.toContain('/nope');
  });

  it('never records private strings from unmatched or parent-router concrete paths', async () => {
    const controller = createFetchController();
    const recorded: {
      method: string;
      route: string;
      status_code: number;
      duration_ms: number;
    }[] = [];
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: controller.fetch,
      disableTimer: true,
    });
    const app = express();
    app.use(expressMiddleware({ client, onRecord: (event) => recorded.push(event) }));
    const router = express.Router();
    router.get('/orders/:orderId', (_req, res) => res.sendStatus(204));
    app.use('/tenants/:tenantId', router);
    app.use((_req, res) => res.status(404).json({ error: 'not found' }));

    await request(app).get('/users/alice-private/no-route');
    await request(app).get('/tenants/customer-secret/orders/order-secret');
    await client.flush();

    const serializedRoutes = JSON.stringify(recorded.map((event) => event.route));
    expect(serializedRoutes).not.toContain('alice-private');
    expect(serializedRoutes).not.toContain('customer-secret');
    expect(serializedRoutes).not.toContain('order-secret');
    expect(recorded.map((event) => event.route)).toContain('/orders/:orderId');
  });

  it('records response payload byte count without retaining content', async () => {
    const { app, client, recorded } = setup();
    await request(app).get('/health');
    await client.flush();
    const expected = Buffer.byteLength(JSON.stringify({ ok: true }));
    expect(recorded[0].response_bytes).toBe(expected);
    expect(JSON.stringify(recorded[0])).not.toContain('ok');
  });

  it('records POST with a body without capturing the body', async () => {
    const { app, client, controller, recorded } = setup();
    await request(app).post('/orders').send({ secret: 'value', token: 'abc' });
    await client.flush();
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].route).toBe('/orders');
    expect(controller.requests).toHaveLength(1);
    const body = JSON.parse(controller.requests[0].body);
    const allowed = [
      'duration_ms',
      'event_id',
      'method',
      'response_bytes',
      'route',
      'status_code',
      'timestamp',
    ];
    for (const event of body.events) {
      const keys = Object.keys(event).sort();
      for (const k of keys) expect([...allowed, 'release']).toContain(k);
      expect(event).not.toHaveProperty('body');
      expect(event).not.toHaveProperty('secret');
      expect(event).not.toHaveProperty('token');
    }
  });

  it('does not delay the application response when ingest is slow', async () => {
    const slowFetch = async () => {
      await new Promise((r) => setTimeout(r, 300));
      return new Response('{}', { status: 202 });
    };
    const client = createAppHealthClient({
      key: 'ahk_test',
      endpoint: 'http://localhost:8787/v1/ingest',
      fetch: slowFetch,
      disableTimer: true,
    });
    const app = express();
    app.use(expressMiddleware({ client }));
    app.get('/health', (_req, res) => res.status(200).json({ ok: true }));
    const t0 = Date.now();
    const res = await request(app).get('/health');
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    // The response returns well before the 300ms ingest completes.
    expect(elapsed).toBeLessThan(250);
  });

  it('records a positive integer duration', async () => {
    const { app, client, recorded } = setup();
    await request(app).get('/health');
    await client.flush();
    expect(Number.isInteger(recorded[0].duration_ms)).toBe(true);
    expect(recorded[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});
