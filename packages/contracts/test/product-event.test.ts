import { describe, expect, it } from 'vitest';
import {
  ProductEventV1,
  PRODUCT_EVENT_SCHEMA,
  MAX_PRODUCT_EVENT_PROPERTIES,
} from '../src/index.js';

const base = {
  schemaVersion: PRODUCT_EVENT_SCHEMA,
  event_id: '3f4b9a1e-2c7d-4e5f-8a9b-0c1d2e3f4a5b',
  occurred_at: 1_758_000_000_000,
  channel: 'browser' as const,
};

const pageView = { ...base, type: 'page_view', path: '/pricing' };
const named = { ...base, type: 'event', name: 'checkout.completed' };
const revenueEvent = {
  ...base,
  type: 'revenue',
  revenue: { amount_cents: 2_500, currency: 'USD' },
};

describe('ProductEventV1 envelope', () => {
  it('accepts each channel and type with its required fields', () => {
    for (const channel of ['browser', 'server', 'manual'] as const) {
      expect(ProductEventV1.safeParse({ ...pageView, channel }).success).toBe(true);
    }
    expect(ProductEventV1.safeParse(named).success).toBe(true);
    expect(ProductEventV1.safeParse({ ...base, type: 'identify', name: 'user.seen' }).success).toBe(true);
    expect(ProductEventV1.safeParse(revenueEvent).success).toBe(true);
  });

  it('enforces the type-shape refinement structurally', () => {
    expect(ProductEventV1.safeParse({ ...base, type: 'page_view', name: 'x.y', path: '/a' }).success).toBe(false);
    expect(ProductEventV1.safeParse({ ...base, type: 'page_view' }).success).toBe(false);
    expect(ProductEventV1.safeParse({ ...base, type: 'event' }).success).toBe(false);
    expect(ProductEventV1.safeParse({ ...base, type: 'revenue' }).success).toBe(false);
    expect(ProductEventV1.safeParse({ ...named, revenue: { amount_cents: 1, currency: 'USD' } }).success).toBe(false);
  });

  it('rejects paths carrying queries, fragments, or credentials', () => {
    for (const bad of ['/a?x=1', '/a#frag', 'https://x/a', '/a@b']) {
      expect(ProductEventV1.safeParse({ ...pageView, path: bad }).success).toBe(false);
    }
  });

  it('bounds properties to flat scalars', () => {
    const ok = { ...named, properties: { plan: 'pro', seats: 3, trial: false } };
    expect(ProductEventV1.safeParse(ok).success).toBe(true);
    expect(
      ProductEventV1.safeParse({ ...named, properties: { nested: { a: 1 } } }).success,
    ).toBe(false);
    expect(
      ProductEventV1.safeParse({
        ...named,
        properties: Object.fromEntries(
          Array.from({ length: MAX_PRODUCT_EVENT_PROPERTIES + 1 }, (_, i) => [`k${i}`, i]),
        ),
      }).success,
    ).toBe(false);
    expect(
      ProductEventV1.safeParse({ ...named, properties: { 'Not-A-Key': 1 } }).success,
    ).toBe(false);
  });

  it('rejects unknown fields and a foreign schema version', () => {
    expect(ProductEventV1.safeParse({ ...named, extra: true }).success).toBe(false);
    expect(
      ProductEventV1.safeParse({ ...named, schemaVersion: 'app-health.product-event.v0' }).success,
    ).toBe(false);
  });

  it('bounds identity to opaque anonymous strings', () => {
    expect(
      ProductEventV1.safeParse({ ...named, visitor_id: 'anon_abc-123', session_id: 's_1' }).success,
    ).toBe(true);
    expect(
      ProductEventV1.safeParse({ ...named, visitor_id: 'sarthak@example.com' }).success,
    ).toBe(false);
  });

  it('bounds revenue to integer cents with an ISO currency', () => {
    expect(
      ProductEventV1.safeParse({
        ...revenueEvent,
        revenue: { amount_cents: 1.5, currency: 'USD' },
      }).success,
    ).toBe(false);
    expect(
      ProductEventV1.safeParse({
        ...revenueEvent,
        revenue: { amount_cents: 100, currency: 'usdollar' },
      }).success,
    ).toBe(false);
  });
});
