// Contract tests for the canonical zero-dependency drop-in log client at
// examples/dropin-log-client/ping.ts. Fleet consumers copy that file verbatim
// into their own repositories, so its fail-open and payload contract is pinned
// here once rather than re-tested in every consumer.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPing } from '../../../examples/dropin-log-client/ping';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function capture(result: () => Promise<Response>) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return result();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('drop-in ping.ts log client', () => {
  it('is a silent no-op without an ingest key', async () => {
    vi.stubEnv('APP_HEALTH_INGEST_KEY', '');
    const { calls, fetchImpl } = capture(async () => new Response(null, { status: 202 }));
    const ping = createPing({ fetch: fetchImpl });
    expect(await ping('signup')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('posts one single-log v1 batch with a bearer key and strips undefined props', async () => {
    const { calls, fetchImpl } = capture(async () => new Response('{}', { status: 202 }));
    const ping = createPing({
      key: 'ahk_test',
      url: 'http://localhost/v1/logs',
      environment: 'staging',
      fetch: fetchImpl,
    });
    expect(
      await ping('waitlist.join', { title: 'synthetic', props: { plan: 'free', skip: undefined } }),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('http://localhost/v1/logs');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.authorization).toBe('Bearer ahk_test');
    const body = JSON.parse(String(init.body));
    expect(body.schema_version).toBe('v1');
    expect(body.environment).toBe('staging');
    expect(typeof body.batch_id).toBe('string');
    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]).toMatchObject({
      event: 'waitlist.join',
      level: 'info',
      title: 'synthetic',
      props: { plan: 'free' },
    });
    expect('skip' in body.logs[0].props).toBe(false);
  });

  it('returns false on non-2xx and network failure without throwing', async () => {
    const errors: unknown[] = [];
    const { fetchImpl } = capture(async () => new Response(null, { status: 500 }));
    const rejected = createPing({
      key: 'k',
      url: 'http://localhost/v1/logs',
      fetch: fetchImpl,
      onError: (err) => errors.push(err),
    });
    await expect(rejected('evt')).resolves.toBe(false);
    const throwing = createPing({
      key: 'k',
      url: 'http://localhost/v1/logs',
      fetch: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
      onError: (err) => errors.push(err),
    });
    await expect(throwing('evt')).resolves.toBe(false);
    expect(errors).toHaveLength(2);
  });

  it('aborts delivery after timeoutMs instead of hanging', async () => {
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const ping = createPing({
      key: 'k',
      url: 'http://localhost/v1/logs',
      timeoutMs: 5,
      fetch: hanging,
    });
    await expect(ping('evt')).resolves.toBe(false);
  });

  it('maps level helpers to explicit log levels', async () => {
    const { calls, fetchImpl } = capture(async () => new Response(null, { status: 202 }));
    const ping = createPing({ key: 'k', url: 'http://localhost/v1/logs', fetch: fetchImpl });
    await ping.debug('d');
    await ping.info('i');
    await ping.warn('w');
    await ping.error('e');
    const levels = calls.map((call) => JSON.parse(String(call.init.body)).logs[0].level);
    expect(levels).toEqual(['debug', 'info', 'warn', 'error']);
  });
});
