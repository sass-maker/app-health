// Conservative field and route normalization for the V1 contract.
//
// The V1 event only carries method, route template, status_code, duration_ms,
// response payload byte count, timestamp, and optional release. This module normalizes framework-provided
// values into the bounded, uppercase, slash-prefixed shape the contract
// requires. Official adapters call this only with framework route templates;
// they drop requests when no trusted template exists. It never reads headers,
// query, params, or bodies.

import {
  MAX_METHOD_LENGTH,
  MAX_RELEASE_LENGTH,
  MAX_ROUTE_LENGTH,
  MAX_STATUS_CODE,
  MAX_DURATION_MS,
  MAX_RESPONSE_BYTES,
  MIN_STATUS_CODE,
} from './contracts.js';

/** Uppercase, trim, and bound an HTTP method. Returns null if not normalizable. */
export function normalizeMethod(method: unknown): string | null {
  if (typeof method !== 'string') return null;
  const upper = method.trim().toUpperCase();
  if (upper.length === 0 || upper.length > MAX_METHOD_LENGTH) return null;
  if (!/^[A-Z]+$/.test(upper)) return null;
  return upper;
}

/**
 * Normalize a trusted framework route template.
 *
 * Replaces segments that are clearly identifiers (all digits, or an RFC 4122
 * UUID) with `:id` as defense in depth. Official adapters never pass unmatched
 * concrete paths to this function. Query strings and fragments are stripped
 * defensively for framework and direct-client callers.
 */
export function normalizeRoutePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  let p = path.trim();
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h >= 0) p = p.slice(0, h);
  if (p.length === 0 || !p.startsWith('/')) return null;
  const segments = p.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '') {
      // Preserve leading empty segment and doubled slashes collapse naturally.
      out.push('');
      continue;
    }
    out.push(isIdentifierSegment(seg) ? ':id' : seg);
  }
  const normalized = out.join('/');
  if (normalized.length > MAX_ROUTE_LENGTH) return null;
  return normalized;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;

function isIdentifierSegment(segment: string): boolean {
  return NUMERIC_RE.test(segment) || UUID_RE.test(segment);
}

/** Bound and validate a status code. Returns null if out of HTTP range. */
export function normalizeStatus(status: unknown): number | null {
  if (typeof status !== 'number' || !Number.isInteger(status)) return null;
  if (status < MIN_STATUS_CODE || status > MAX_STATUS_CODE) return null;
  return status;
}

/** Bound and validate a duration in milliseconds. Returns null if invalid. */
export function normalizeDuration(durationMs: unknown): number | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  if (durationMs < 0) return null;
  const rounded = Math.round(durationMs);
  if (!Number.isInteger(rounded)) return null;
  if (rounded < 0 || rounded > MAX_DURATION_MS) return null;
  return rounded;
}

/** Bound a response payload byte count. Returns undefined when unmeasured. */
export function normalizeResponseBytes(bytes: unknown): number | undefined {
  if (bytes === undefined || bytes === null) return undefined;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined;
  const rounded = Math.round(bytes);
  if (!Number.isInteger(rounded) || rounded < 0 || rounded > MAX_RESPONSE_BYTES) return undefined;
  return rounded;
}

const SAFE_RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Bound an optional release tag to machine-safe version characters.
 *
 * Releases are operator metadata, never request metadata. Unsafe strings are
 * omitted instead of partially redacted so emails, URLs, query strings, and
 * free-form private values cannot accidentally become telemetry dimensions.
 */
export function normalizeRelease(release: unknown): string | undefined {
  if (release === undefined || release === null) return undefined;
  if (typeof release !== 'string') return undefined;
  const trimmed = release.trim();
  if (trimmed !== release) return undefined;
  if (trimmed.length === 0 || trimmed.length > MAX_RELEASE_LENGTH) return undefined;
  if (!SAFE_RELEASE_RE.test(trimmed)) return undefined;
  return trimmed;
}

/** Bound and validate a timestamp in epoch milliseconds. Returns null if invalid. */
export function normalizeTimestamp(timestamp: unknown): number | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null;
  const rounded = Math.round(timestamp);
  if (!Number.isInteger(rounded) || rounded < 0) return null;
  return rounded;
}
