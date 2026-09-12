import { describe, expect, it, vi } from 'vitest';
import type { AppHealthClient, EventInput } from '../src/index.js';
import { withPagesFunctionHealth, type PagesFunctionContext } from '../src/pages.js';

function fixtureContext(url = 'https://example.test/anime/42?token=secret'): PagesFunctionContext {
  return {
    request: new Request(url, {
      headers: { authorization: 'Bearer private', cookie: 'session=private' },
    }),
    env: {},
    params: {},
    data: {},
    next: async () => new Response('next'),
    waitUntil: vi.fn(),
  };
}

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

describe('Pages Function wrapper', () => {
  it('preserves response identity and the original handler error when instrumentation throws', async () => {
    const { client } = clientSpy();
    const options = {
      client,
      route: '/health',
      onRecord: () => {
        throw new Error('hook');
      },
    };
    const response = new Response('ok', { status: 201 });
    expect(await withPagesFunctionHealth(options, async () => response)(fixtureContext())).toBe(
      response,
    );
    const failure = new Error('original handler error');
    await expect(
      withPagesFunctionHealth(options, async () => {
        throw failure;
      })(fixtureContext()),
    ).rejects.toBe(failure);
  });
  it('records the explicit template, preserves the response, and uses waitUntil', async () => {
    const { client, events, flush } = clientSpy();
    const context = fixtureContext();
    const wrapped = withPagesFunctionHealth(
      { client, route: '/anime/:malId' },
      async () =>
        new Response('created', {
          status: 201,
          headers: { 'x-handler': 'preserved' },
        }),
    );

    const response = await wrapped(context);

    expect(response.status).toBe(201);
    expect(response.headers.get('x-handler')).toBe('preserved');
    expect(await response.text()).toBe('created');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'GET',
      route: '/anime/:malId',
      status_code: 201,
    });
    expect(JSON.stringify(events)).not.toContain('42');
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(flush).toHaveBeenCalledOnce();
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it('is fail-open when the optional client resolver returns null', async () => {
    const wrapped = withPagesFunctionHealth(
      { client: () => null, route: '/health' },
      async () => new Response('ok'),
    );

    const response = await wrapped(fixtureContext('https://example.test/health'));

    expect(await response.text()).toBe('ok');
  });

  it('does not delay or change a response when delivery fails', async () => {
    const { client } = clientSpy();
    client.flush = vi.fn(async () => {
      throw new Error('ingest unavailable');
    });
    const context = fixtureContext('https://example.test/health');
    const wrapped = withPagesFunctionHealth(
      { client, route: '/health' },
      async () => new Response('ok', { status: 202 }),
    );

    const response = await wrapped(context);

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('ok');
    expect(context.waitUntil).toHaveBeenCalledOnce();
  });

  it('records a failure and rethrows the same error', async () => {
    const { client, events } = clientSpy();
    const expected = new Error('failed');
    const wrapped = withPagesFunctionHealth({ client, route: '/anime/:malId' }, async () => {
      throw expected;
    });

    await expect(wrapped(fixtureContext())).rejects.toBe(expected);
    expect(events[0]).toMatchObject({ route: '/anime/:malId', status_code: 500 });
  });

  it('drops an invalid route template without inspecting the URL', async () => {
    const { client, events, flush } = clientSpy();
    const wrapped = withPagesFunctionHealth(
      { client, route: 'anime/42' },
      async () => new Response('ok'),
    );

    const response = await wrapped(fixtureContext());

    expect(response.status).toBe(200);
    expect(events).toHaveLength(0);
    expect(flush).not.toHaveBeenCalled();
  });
});
