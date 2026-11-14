import type { Buffer } from 'node:buffer';

export type FailureKind =
  | 'dns'
  | 'connect'
  | 'tls'
  | 'timeout'
  | 'network'
  | 'incomplete'
  | 'body_too_large'
  | 'http'
  | 'content_type'
  | 'parse'
  | 'semantic'
  | 'asset';

export interface Phases {
  dns_ms?: number;
  connect_ms?: number;
  tls_ms?: number;
  headers_ms?: number;
  body_ms?: number;
  total_ms: number;
}

export interface HttpResult {
  failure?: FailureKind;
  status?: number;
  contentType?: string;
  body?: Buffer;
  phases: Phases;
  serverMs?: number;
  edge?: string;
}

interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
}
export type Measure = (request: HttpRequest) => Promise<HttpResult>;
