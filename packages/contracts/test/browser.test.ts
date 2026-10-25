import { describe, expect, it } from 'vitest';
import {
  BrowserBatchV1,
  BrowserEventV1,
  BrowserReportFilter,
  PresenceSnapshot,
} from '../src/browser.js';
const event = {
  event_id: 'df6d2fa1-c91d-4c10-b65f-38c63b05c122',
  timestamp: 123,
  type: 'pageview',
  path: '/pricing',
};
describe('opt-in browser contract', () => {
  it('accepts minimal pageviews, named events and empty heartbeats', () => {
    expect(BrowserEventV1.parse(event).referrer).toBe('');
    expect(
      BrowserEventV1.safeParse({ ...event, type: 'event', name: 'signup.completed' }).success,
    ).toBe(true);
    expect(
      BrowserBatchV1.safeParse({
        schema_version: 1,
        batch_id: event.event_id,
        session_id: event.event_id,
        public_key: 'ahk_pub_test',
        events: [],
      }).success,
    ).toBe(true);
  });
  it('rejects implicit identity, query strings, unknown fields and invalid event names', () => {
    for (const bad of [
      { ...event, type: 'event' },
      { ...event, name: 'signup' },
      { ...event, type: 'event', name: 'Email me' },
      { ...event, path: '/?token=private' },
      { ...event, path: '/#private' },
      { ...event, email: 'private@example.com' },
      { ...event, referrer: 'https://example.com/path' },
    ])
      expect(BrowserEventV1.safeParse(bad).success).toBe(false);
    expect(
      PresenceSnapshot.safeParse({
        measured_at: 1,
        ttl_ms: 45000,
        total: 1,
        projects: [{ app_id: 'a', environment_id: 'e', active: 1 }],
      }).success,
    ).toBe(true);
    expect(
      PresenceSnapshot.safeParse({ measured_at: 1, ttl_ms: 45000, total: -1, projects: [] })
        .success,
    ).toBe(false);
  });

  it('bounds segment filters and rejects injection shaped values', () => {
    expect(
      BrowserReportFilter.safeParse({
        range: '24h',
        path: "/a'b",
        country: 'Unknown',
        device: 'Mobile',
      }).success,
    ).toBe(true);
    expect(BrowserReportFilter.safeParse({ range: '24h', path: '/?secret' }).success).toBe(false);
    expect(BrowserReportFilter.safeParse({ range: '24h', country: 'india' }).success).toBe(false);
    expect(BrowserReportFilter.safeParse({ range: '24h', browser: "Chrome' OR 1=1" }).success).toBe(
      false,
    );
  });
});

it('accepts only bounded flat explicit event properties and finite values', () => {
  const custom = { ...event, type: 'event', name: 'purchase' };
  expect(
    BrowserEventV1.safeParse({
      ...custom,
      properties: { plan: 'pro', seats: 4, trial: false },
      value: -10,
    }).success,
  ).toBe(true);
  for (const extra of [
    { properties: { nested: {} } },
    { properties: { missing: null } },
    { properties: { too_long: 'x'.repeat(201) } },
    { properties: { 'invalid-key': true } },
    { properties: { constructor: 'private' } },
    { properties: { amount: Infinity } },
    {
      properties: Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, 1])),
    },
    { value: NaN },
    { value: 1e12 + 1 },
  ])
    expect(BrowserEventV1.safeParse({ ...custom, ...extra }).success).toBe(false);
  expect(BrowserEventV1.safeParse({ ...event, properties: {} }).success).toBe(false);
  expect(BrowserEventV1.safeParse({ ...event, value: 1 }).success).toBe(false);
});
