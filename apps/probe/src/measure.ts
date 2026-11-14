// Complete-response HTTP measurement on a fresh connection. The deadline runs
// from request start until the last body byte, so a fast HTTP 200 whose body
// stalls is a timeout, not a success. Only the status, content type, two
// numeric timing headers (Server-Timing, cf-ray colo) and the body (kept in
// memory for validation, never reported) are read from the response.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { FailureKind, HttpResult, Phases, Measure } from './types.d.ts';
export type { FailureKind, HttpResult, Measure } from './types.d.ts';

type HttpRequest = Parameters<Measure>[0];

interface Marks {
  start: number;
  lookup?: number;
  connect?: number;
  secure?: number;
  headers?: number;
  end?: number;
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA']);
const round = (value: number) => Math.round(value * 10) / 10;

/** Classify a transport error by the phase it interrupted. */
export function classifyError(
  error: NodeJS.ErrnoException,
  marks: Pick<Marks, 'connect' | 'secure' | 'headers'>,
  https: boolean,
): FailureKind {
  const code = error.code ?? '';
  if (DNS_CODES.has(code)) return 'dns';
  if (marks.headers !== undefined) return 'incomplete';
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code)) return 'tls';
  if (marks.connect === undefined) return 'connect';
  if (https && marks.secure === undefined) return 'tls';
  return 'network';
}

/** Numeric `dur` of the `total` entry, else the largest entry. Names and descriptions are dropped. */
export function parseServerTiming(header: string | string[] | undefined): number | undefined {
  if (!header) return undefined;
  const values = (Array.isArray(header) ? header.join(',') : header).split(',');
  let total: number | undefined;
  let largest: number | undefined;
  for (const value of values) {
    const [name, ...params] = value.trim().split(';');
    const dur = params.map((param) => /^\s*dur=([0-9.]+)\s*$/.exec(param)?.[1]).find(Boolean);
    const parsed = dur === undefined ? NaN : Number(dur);
    if (!Number.isFinite(parsed)) continue;
    if (name?.trim() === 'total') total = parsed;
    largest = largest === undefined ? parsed : Math.max(largest, parsed);
  }
  const chosen = total ?? largest;
  return chosen === undefined ? undefined : round(chosen);
}

export function parseEdge(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value ? /-([A-Z]{3})$/.exec(value.trim())?.[1] : undefined;
}

function phasesFrom(marks: Marks, now: number): Phases {
  const phases: Phases = { total_ms: round((marks.end ?? now) - marks.start) };
  if (marks.lookup !== undefined) phases.dns_ms = round(marks.lookup - marks.start);
  if (marks.connect !== undefined)
    phases.connect_ms = round(marks.connect - (marks.lookup ?? marks.start));
  if (marks.secure !== undefined && marks.connect !== undefined)
    phases.tls_ms = round(marks.secure - marks.connect);
  if (marks.headers !== undefined) phases.headers_ms = round(marks.headers - marks.start);
  if (marks.headers !== undefined && marks.end !== undefined)
    phases.body_ms = round(marks.end - marks.headers);
  return phases;
}

function watchSocket(socket: Socket, marks: Marks): void {
  socket.once('lookup', () => (marks.lookup = performance.now()));
  socket.once('connect', () => (marks.connect = performance.now()));
  socket.once('secureConnect', () => (marks.secure = performance.now()));
}

function readResponse(
  response: IncomingMessage,
  request: HttpRequest,
  marks: Marks,
  finish: (result: Omit<HttpResult, 'phases'>) => void,
): void {
  marks.headers = performance.now();
  const chunks: Buffer[] = [];
  let size = 0;
  const base = {
    status: response.statusCode,
    contentType: response.headers['content-type'],
    serverMs: parseServerTiming(response.headers['server-timing']),
    edge: parseEdge(response.headers['cf-ray']),
  };
  response.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > request.maxBytes) {
      finish({ ...base, failure: 'body_too_large' });
      response.destroy();
      return;
    }
    chunks.push(chunk);
  });
  response.once('end', () => {
    marks.end = performance.now();
    finish({ ...base, body: Buffer.concat(chunks) });
  });
}

/** Measure one request on a fresh connection; never throws. */
export const measureHttp: Measure = (request) =>
  new Promise((resolve) => {
    const url = new URL(request.url);
    const https = url.protocol === 'https:';
    const marks: Marks = { start: performance.now() };
    let settled = false;
    const finish = (result: Omit<HttpResult, 'phases'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, phases: phasesFrom(marks, performance.now()) });
      outgoing.destroy();
    };
    const send = https ? httpsRequest : httpRequest;
    const outgoing = send(url, {
      method: request.method,
      agent: false,
      headers: {
        'user-agent': request.userAgent,
        accept: '*/*',
        ...(request.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    const timer = setTimeout(() => finish({ failure: 'timeout' }), request.timeoutMs);
    outgoing.once('socket', (socket) => watchSocket(socket, marks));
    outgoing.once('response', (response) => {
      response.once('error', (error) => finish({ failure: classifyError(error, marks, https) }));
      response.once('aborted', () => finish({ failure: 'incomplete' }));
      readResponse(response, request, marks, finish);
    });
    outgoing.once('error', (error) => finish({ failure: classifyError(error, marks, https) }));
    outgoing.end(request.body);
  });
