interface ProductAttribution {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  entry_path: string;
}
/** Distribution-safe canonical product-event input. No request object is accepted or inspected. */
export interface ProductMoney {
  amount_minor: number;
  currency: string;
}
export interface ProductTrackInput {
  event_id?: string;
  occurred_at?: number;
  type?: 'event' | 'identify' | 'revenue';
  path?: string;
  visitor_id?: string;
  session_id?: string;
  properties?: Record<string, string | number | boolean>;
  value?: number;
  revenue?: ProductMoney;
  interactive?: boolean;
  attribution?: ProductAttribution;
}
export interface ProductEvent extends ProductTrackInput {
  schemaVersion: 'app-health.product-event.v1';
  event_id: string;
  occurred_at: number;
  channel: 'server';
  type: 'event' | 'identify' | 'revenue';
  name: string;
}
export interface ProductBatch {
  schema_version: 1;
  batch_id: string;
  environment?: string;
  events: ProductEvent[];
}
const opaque = (value: string | undefined) =>
  value === undefined ||
  /^(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(
    value,
  );
function validProperties(properties: ProductTrackInput['properties']) {
  if (properties === undefined) return true;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    Object.keys(properties).length > 30
  )
    return false;
  return Object.entries(properties).every(
    ([key, value]) =>
      key.length > 0 &&
      key.length <= 64 &&
      /^[\u0020-\u007e\u0080-\uffff]*$/.test(key) &&
      !['__proto__', 'constructor', 'prototype'].includes(key) &&
      (typeof value === 'boolean' ||
        (typeof value === 'string' && value.length <= 255) ||
        (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12)),
  );
}
function validAttribution(attribution: ProductAttribution | undefined) {
  if (attribution === undefined) return true;
  if (!attribution || !attribution.entry_path?.startsWith('/')) return false;
  return Object.entries(attribution).every(([key, value]) => {
    if (
      !['entry_path', 'source', 'medium', 'campaign', 'content', 'term'].includes(key) ||
      typeof value !== 'string'
    )
      return false;
    return key === 'entry_path'
      ? value.length <= 256 && !/[?#@\\\s]/.test(value)
      : value.length <= 100 && /^[a-zA-Z0-9 _.,:+/-]*$/.test(value);
  });
}
function validPath(path: string | undefined) {
  if (path === undefined) return true;
  try {
    return (
      path.startsWith('/') && path.length <= 256 && !/[?#@\\\s]/.test(decodeURIComponent(path))
    );
  } catch {
    return false;
  }
}
function validRevenue(input: ProductTrackInput) {
  if (input.type !== 'revenue') return input.revenue === undefined;
  const revenue = input.revenue;
  return (
    !!revenue &&
    Number.isSafeInteger(revenue.amount_minor) &&
    revenue.amount_minor >= 0 &&
    revenue.amount_minor <= 1e12 &&
    /^[A-Z]{3}$/.test(revenue.currency)
  );
}
function validProductInput(input: ProductTrackInput) {
  if (!opaque(input.visitor_id) || !opaque(input.session_id) || !validProperties(input.properties))
    return false;
  if (!validAttribution(input.attribution) || !validPath(input.path) || !validRevenue(input))
    return false;
  if (input.value !== undefined && (!Number.isFinite(input.value) || Math.abs(input.value) > 1e12))
    return false;
  if (input.interactive !== undefined && typeof input.interactive !== 'boolean') return false;
  return input.type === undefined || ['event', 'identify', 'revenue'].includes(input.type);
}
export function buildProductEvent(
  name: string,
  input: ProductTrackInput,
  now: () => number,
  uuid: () => string,
): ProductEvent | null {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.trim().length > 64 ||
    !/^[\u0020-\u007e\u0080-\uffff]*$/.test(name) ||
    !validProductInput(input)
  )
    return null;
  const event: ProductEvent = {
    schemaVersion: 'app-health.product-event.v1',
    event_id: input.event_id ?? uuid(),
    occurred_at: input.occurred_at ?? now(),
    channel: 'server',
    type: input.type ?? 'event',
    name: name.trim(),
  };
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.event_id) ||
    !Number.isSafeInteger(event.occurred_at) ||
    event.occurred_at < 0
  )
    return null;
  for (const key of [
    'path',
    'visitor_id',
    'session_id',
    'properties',
    'value',
    'revenue',
    'interactive',
    'attribution',
  ] as const)
    if (input[key] !== undefined) Object.assign(event, { [key]: input[key] });
  return JSON.parse(JSON.stringify(event)) as ProductEvent;
}
