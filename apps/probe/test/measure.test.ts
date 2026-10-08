import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyError, measureHttp, parseEdge, parseServerTiming } from '../src/measure.ts';

let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/ok') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'server-timing': 'db;dur=12.5, total;dur=40.04',
        'cf-ray': '8f00aa11bb22cc33-BOM',
      });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/slow-body') {
      // Fast headers, then a body that never completes inside the deadline.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"partial":');
      setTimeout(() => response.end('true}'), 400);
      return;
    }
    if (request.url === '/truncated') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      response.write('{"cut":');
      setTimeout(() => response.socket?.destroy(), 20);
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200);
      response.end('x'.repeat(5000));
      return;
    }
    if (request.url === '/echo' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': request.headers['content-type'] ?? '' });
        response.end(body);
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const base = { method: 'GET' as const, timeoutMs: 2000, maxBytes: 4096, userAgent: 'test' };

describe('measureHttp', () => {
  it('measures a complete response with phases and safe numeric headers', async () => {
    const result = await measureHttp({ ...base, url: `${origin}/ok` });
    expect(result.failure).toBeUndefined();
    expect(result.status).toBe(200);
    expect(result.body?.toString()).toBe('{"ok":true}');
    expect(result.serverMs).toBe(40);
    expect(result.edge).toBe('BOM');
    expect(result.phases.connect_ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.headers_ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.body_ms).toBeGreaterThanOrEqual(0);
    expect(result.phases.total_ms).toBeGreaterThanOrEqual(result.phases.headers_ms ?? 0);
  });

  it('times out a fast-headers, slow-body HTTP 200 instead of passing it', async () => {
    const result = await measureHttp({ ...base, url: `${origin}/slow-body`, timeoutMs: 150 });
    expect(result.failure).toBe('timeout');
    expect(result.status).toBeUndefined();
    expect(result.phases.headers_ms).toBeLessThan(150);
    expect(result.phases.body_ms).toBeUndefined();
    expect(result.phases.total_ms).toBeGreaterThanOrEqual(140);
  });

  it('reports a truncated body as incomplete', async () => {
    const result = await measureHttp({ ...base, url: `${origin}/truncated` });
    expect(result.failure).toBe('incomplete');
  });

  it('stops reading at the body cap', async () => {
    const result = await measureHttp({ ...base, url: `${origin}/large`, maxBytes: 100 });
    expect(result.failure).toBe('body_too_large');
    expect(result.body).toBeUndefined();
  });

  it('sends a fixed JSON fixture for POST journeys', async () => {
    const result = await measureHttp({
      ...base,
      url: `${origin}/echo`,
      method: 'POST',
      body: '{"filters":[]}',
    });
    expect(result.contentType).toBe('application/json');
    expect(result.body?.toString()).toBe('{"filters":[]}');
  });

  it('classifies a refused connection', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await measureHttp({ ...base, url: `http://127.0.0.1:${port}/` });
    expect(result.failure).toBe('connect');
  });
});

describe('classifyError', () => {
  const error = (code: string) => Object.assign(new Error(code), { code });
  it.each([
    ['ENOTFOUND', {}, true, 'dns'],
    ['EAI_AGAIN', { connect: 1, headers: 2 }, true, 'dns'],
    ['ECONNRESET', { connect: 1, secure: 2, headers: 3 }, true, 'incomplete'],
    ['CERT_HAS_EXPIRED', { connect: 1 }, true, 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', { connect: 1 }, true, 'tls'],
    ['ECONNREFUSED', {}, true, 'connect'],
    ['ECONNRESET', { connect: 1 }, true, 'tls'],
    ['ECONNRESET', { connect: 1 }, false, 'network'],
    ['EPIPE', { connect: 1, secure: 2 }, true, 'network'],
  ] as const)('%s with %o (https=%s) is %s', (code, marks, https, kind) => {
    expect(classifyError(error(code), marks, https)).toBe(kind);
  });

  it('treats a missing code as a phase failure', () => {
    expect(classifyError(new Error('x'), {}, false)).toBe('connect');
  });
});

describe('timing headers', () => {
  it('reads only numeric durations from Server-Timing', () => {
    expect(parseServerTiming(undefined)).toBeUndefined();
    expect(parseServerTiming('cache;desc="hit"')).toBeUndefined();
    expect(parseServerTiming('db;dur=5, app;dur=22.26')).toBe(22.3);
    expect(parseServerTiming(['db;dur=5', 'total;dur=9'])).toBe(9);
    expect(parseServerTiming('db;dur=abc')).toBeUndefined();
  });

  it('extracts only a three-letter colo from cf-ray', () => {
    expect(parseEdge('8f00aa11bb22cc33-SIN')).toBe('SIN');
    expect(parseEdge(['abc-FRA'])).toBe('FRA');
    expect(parseEdge('no-colo-here')).toBeUndefined();
    expect(parseEdge(undefined)).toBeUndefined();
  });
});
