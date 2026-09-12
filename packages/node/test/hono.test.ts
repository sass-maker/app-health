import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppHealthClient, EventInput } from '../src/index.js';
import { honoMiddleware } from '../src/hono.js';

function clientSpy() {
  const events: EventInput[] = [];
  const flush = vi.fn(async () => {});
  const client: AppHealthClient = {
    record: (event) => events.push(event),
    log: () => {},
    flush,
    close: async () => {},
    diagnostics: () => ({
      queued: 0,
      sentBatches: 0,
      sentEvents: 0,
      failedBatches: 0,
      retriedBatches: 0,
      droppedInvalid: 0,
      droppedOverflow: 0,
      droppedDelivery: 0,
      lastSendError: null,
    }),
  };
  return { client, events, flush };
}

describe('Hono middleware', () => {
  it('preserves a successful response when an optional observation hook throws', async () => {
    const { client } = clientSpy();
    const app = new Hono();
    app.use(
      '*',
      honoMiddleware({
        client,
        onRecord: () => {
          throw new Error('hook failed');
        },
      }),
    );
    app.get('/health', (context) => context.text('healthy', 201));
    const response = await app.request('/health');
    expect(response.status).toBe(201);
    expect(await response.text()).toBe('healthy');
  });
  it('records only the matched route template and uses waitUntil', async () => {
    const { client, events, flush } = clientSpy();
    const waits: Promise<unknown>[] = [];
    const app = new Hono();
    app.use('*', honoMiddleware({ client }));
    app.get('/users/:id', (context) => context.json({ ok: true }, 201));

    const response = await app.request(
      'https://example.test/users/alice-private?token=secret',
      {
        headers: {
          authorization: 'Bearer private',
          cookie: 'session=private',
        },
      },
      {},
      {
        waitUntil: (promise) => {
          waits.push(promise);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );

    expect(response.status).toBe(201);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'GET',
      route: '/users/:id',
      status_code: 201,
    });
    expect(JSON.stringify(events)).not.toContain('alice-private');
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(flush).toHaveBeenCalledOnce();
    expect(waits).toHaveLength(1);
  });

  it('is a no-op when the lazy resolver is disabled', async () => {
    const app = new Hono();
    app.use('*', honoMiddleware({ client: () => null }));
    app.get('/health', (context) => context.text('ok'));

    const response = await app.request('/health');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('does not delay or change a response when delivery fails', async () => {
    const { client } = clientSpy();
    client.flush = vi.fn(async () => {
      throw new Error('ingest unavailable');
    });
    const waits: Promise<unknown>[] = [];
    const app = new Hono();
    app.use('*', honoMiddleware({ client }));
    app.get('/health', (context) => context.text('ok', 202));

    const response = await app.request(
      '/health',
      undefined,
      {},
      {
        waitUntil: (promise) => {
          waits.push(promise);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('ok');
    expect((await Promise.allSettled(waits))[0]?.status).toBe('rejected');
  });

  it('records a trusted route and rethrows the same error', async () => {
    const { client, events } = clientSpy();
    const expected = new Error('handler failed');
    const app = new Hono();
    app.use('*', honoMiddleware({ client }));
    app.get('/fail/:id', () => {
      throw expected;
    });
    const response = await app.request('/fail/private-value');

    expect(response.status).toBe(500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ route: '/fail/:id', status_code: 500 });
    expect(JSON.stringify(events)).not.toContain('private-value');
  });
});
