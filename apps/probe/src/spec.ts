// Journey probe policy. A journey is one fixed, read-only, public request
// against a production hostname, plus the checks that make its response count
// as usable. Policy is data: apps/probe/journeys.json is generated from the
// canonical SaaS Maker catalog (`projects[].systems.probe`, `pnpm catalog:sync`)
// and is never hand-edited. Catalog policy is GET-only; POST support remains
// for fixed public fixtures passed explicitly with --config.

export interface JsonCheck {
  /** Dotted path into the parsed JSON body, e.g. `filteredList` or `data.items`. */
  path: string;
  /** The value at `path` must be an array with at least this many items. */
  min_items?: number;
  /** The value at `path` must strictly equal this scalar. */
  equals?: string | number | boolean;
}

export interface Expectation {
  status: number;
  /** Case-insensitive prefix of the response Content-Type. */
  content_type?: string;
  /** Literal markers the complete body must contain. */
  body_includes: string[];
  json: JsonCheck[];
  /** Also fetch the first same-origin script or stylesheet referenced by the HTML. */
  first_party_asset: boolean;
}

export interface Journey {
  /** Canonical catalog project id the incident is attributed to. */
  project: string;
  /** Stable journey id, unique within the project. */
  journey: string;
  url: string;
  method: 'GET' | 'POST';
  /** Fixed public JSON fixture for read-only POST queries. Never user data. */
  body?: string;
  /** Reviewed product-specific budget for the complete response. */
  budget_ms: number;
  /** Deadline that ends only after the whole body (and asset) is consumed. */
  timeout_ms: number;
  /** Repeat once on a fresh connection to separate cold and warm backend time. */
  warm_check: boolean;
  expect: Expectation;
}

export interface ProbeSpec {
  schema_version: 1;
  journeys: Journey[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_JOURNEYS = 200;
const MAX_FIXTURE_BYTES = 4096;

export class SpecError extends Error {}

function fail(where: string, message: string): never {
  throw new SpecError(`${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(where, 'must be an object');
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, where: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    fail(where, `must be an integer from ${min} to ${max}`);
  return value as number;
}

function identifier(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value))
    fail(where, 'must be a lowercase id (a-z, 0-9, dash)');
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function probeUrl(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(where, 'must be a URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(where, 'must be a URL');
  }
  const local = url.protocol === 'http:' && isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !local) fail(where, 'must use https');
  if (url.username || url.password) fail(where, 'must not carry credentials');
  if (url.search) fail(where, 'must not carry query values');
  return url.toString();
}

function fixture(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  const body = JSON.stringify(record(value, where));
  if (body.length > MAX_FIXTURE_BYTES) fail(where, `must be under ${MAX_FIXTURE_BYTES} bytes`);
  return body;
}

function jsonCheck(value: unknown, where: string): JsonCheck {
  const raw = record(value, where);
  if (typeof raw.path !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(raw.path))
    fail(`${where}.path`, 'must be a dotted property path');
  const check: JsonCheck = { path: raw.path };
  if (raw.min_items !== undefined)
    check.min_items = boundedInteger(raw.min_items, `${where}.min_items`, 0, 10_000);
  if (raw.equals !== undefined) {
    if (!['string', 'number', 'boolean'].includes(typeof raw.equals))
      fail(`${where}.equals`, 'must be a scalar');
    check.equals = raw.equals as string | number | boolean;
  }
  return check;
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item))
    fail(where, 'must be a list of non-empty strings');
  return value as string[];
}

function expectation(value: unknown, where: string): Expectation {
  const raw = record(value ?? {}, where);
  const json = raw.json === undefined ? [] : raw.json;
  if (!Array.isArray(json)) fail(`${where}.json`, 'must be a list');
  return {
    status:
      raw.status === undefined ? 200 : boundedInteger(raw.status, `${where}.status`, 100, 599),
    content_type: typeof raw.content_type === 'string' ? raw.content_type : undefined,
    body_includes: stringList(raw.body_includes, `${where}.body_includes`),
    json: json.map((check, index) => jsonCheck(check, `${where}.json[${index}]`)),
    first_party_asset: raw.first_party_asset === true,
  };
}

function journey(value: unknown, where: string): Journey {
  const raw = record(value, where);
  const method = raw.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST') fail(`${where}.method`, 'must be GET or POST');
  const body = fixture(raw.body, `${where}.body`);
  if (method === 'GET' && body !== undefined) fail(`${where}.body`, 'is only allowed for POST');
  const budget = boundedInteger(raw.budget_ms, `${where}.budget_ms`, 100, 60_000);
  const timeout =
    raw.timeout_ms === undefined
      ? Math.min(30_000, Math.max(8_000, budget * 4))
      : boundedInteger(raw.timeout_ms, `${where}.timeout_ms`, budget, 60_000);
  return {
    project: identifier(raw.project, `${where}.project`),
    journey: identifier(raw.journey, `${where}.journey`),
    url: probeUrl(raw.url, `${where}.url`),
    method,
    body,
    budget_ms: budget,
    timeout_ms: timeout,
    warm_check: raw.warm_check === true,
    expect: expectation(raw.expect, `${where}.expect`),
  };
}

/** Validate untrusted policy JSON. Throws SpecError naming the first bad field. */
export function parseSpec(value: unknown): ProbeSpec {
  const raw = record(value, 'spec');
  if (raw.schema_version !== 1) fail('spec.schema_version', 'must be 1');
  if (!Array.isArray(raw.journeys) || raw.journeys.length === 0)
    fail('spec.journeys', 'must be a non-empty list');
  if (raw.journeys.length > MAX_JOURNEYS) fail('spec.journeys', `at most ${MAX_JOURNEYS}`);
  const journeys = raw.journeys.map((item, index) => journey(item, `spec.journeys[${index}]`));
  const keys = new Set<string>();
  for (const item of journeys) {
    const key = journeyKey(item);
    if (keys.has(key)) fail('spec.journeys', `duplicate journey ${key}`);
    keys.add(key);
  }
  return { schema_version: 1, journeys };
}

export function journeyKey(item: Pick<Journey, 'project' | 'journey'>): string {
  return `${item.project}/${item.journey}`;
}
