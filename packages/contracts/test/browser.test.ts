import { describe, expect, it } from 'vitest';
import { BrowserBatchV1, BrowserEventV1, PresenceSnapshot } from '../src/browser.js';
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
});
