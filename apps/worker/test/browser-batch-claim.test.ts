import { expect, it, vi } from 'vitest';
import {
  claimBrowserBatch,
  compatibleBrowserBatch,
  prepareBrowserBatch,
} from '../src/browser-batch-claim.js';
import { acceptBrowserVisitorBatch } from '../src/browser-visitor-daily.js';
import { acceptBrowser } from '../src/browser-routes.js';
import { InMemoryAdapter } from '../src/in-memory-adapter.js';
import {
  digestBrowserEventFacts,
  serializeBrowserEventFacts,
} from '../src/browser-facts-digest.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import { analysisDatabase } from './analysis-sqlite.js';

function batch(): CollectedBrowserBatch {
  return {
    workspace: 'ws',
    app_id: 'app',
    environment_id: 'env',
    batch_id: crypto.randomUUID(),
    received_at: Date.now(),
    session_hash: 's',
    visitor_hash: 'a'.repeat(64),
    events: [
      {
        event_id: crypto.randomUUID(),
        timestamp: Date.now() - 1000,
        type: 'event',
        name: 'purchase',
        path: '/pricing',
        referrer: '',
        properties: { plan: 'pro', seats: 2 },
        value: 29,
      },
    ],
  };
}
it('claims immutable facts transactionally before enqueueing and rejects changed/downgraded retries', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    const original = batch();
    expect(await claimBrowserBatch(db, original)).toBe(true);
    expect(
      await claimBrowserBatch(db, { ...original, received_at: original.received_at + 100 }),
    ).toBe(true);
    expect(
      await claimBrowserBatch(db, {
        ...original,
        events: [{ ...original.events[0], properties: { seats: 2, plan: 'pro' } }],
      }),
    ).toBe(true);
    expect(
      await claimBrowserBatch(db, {
        ...original,
        metadata: { channel: 'Referral', country: 'IN', device: 'Mobile', browser: 'Safari' },
      }),
    ).toBe(true);
    expect(
      await claimBrowserBatch(db, { ...original, events: [{ ...original.events[0], value: 30 }] }),
    ).toBe(false);
    expect(
      await claimBrowserBatch(db, {
        ...original,
        events: [{ ...original.events[0], properties: undefined, value: undefined }],
      }),
    ).toBe(false);
    expect(await claimBrowserBatch(db, { ...original, session_hash: 'other' })).toBe(false);
    expect(
      sqlite.prepare('SELECT COUNT(*) AS total FROM browser_expanded_batch_claims').get(),
    ).toMatchObject({ total: 1 });
    expect(await claimBrowserBatch(db, { ...original, workspace: 'other' })).toBe(true);
  } finally {
    sqlite.close();
  }
});
it('acknowledges accepted legacy facts without re-enqueueing context or poisoning archive deduplication', async () => {
  const { db, sqlite } = analysisDatabase();
  try {
    const original = batch();
    original.events = original.events.map(
      ({ properties: _properties, value: _value, ...event }) => event,
    );
    await acceptBrowserVisitorBatch(db, original, original.received_at);
    const retry = await prepareBrowserBatch(
      { ...original, session_hash: 'changed-context' },
      undefined,
      false,
    );
    expect(await compatibleBrowserBatch(db, retry)).toBe('accepted');
    const send = vi.fn();
    const repos = (await InMemoryAdapter.create()).asRepositories();
    const response = await acceptBrowser(
      retry,
      undefined,
      { DB: db, BROWSER_EVENTS: { send } },
      repos,
      false,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ duplicate: true, accepted: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(
      await compatibleBrowserBatch(db, {
        ...retry,
        events: [{ ...retry.events[0], path: '/changed' }],
      }),
    ).toBeNull();
    expect(
      await compatibleBrowserBatch(db, {
        ...retry,
        events: [{ ...retry.events[0], properties: { plan: 'pro' } }],
      }),
    ).toBeNull();
    expect(
      sqlite.prepare('SELECT COUNT(*) AS total FROM browser_expanded_batch_claims').get(),
    ).toMatchObject({ total: 0 });
    const plain = await prepareBrowserBatch(
      { ...original, batch_id: crypto.randomUUID() },
      undefined,
      false,
    );
    await acceptBrowserVisitorBatch(db, plain, plain.received_at);
    expect(await compatibleBrowserBatch(db, plain)).toMatchObject({ facts_digest_version: 2 });
  } finally {
    sqlite.close();
  }
});
it('preserves legacy v1 digests and authenticates expanded v2 session and event facts', async () => {
  const original = batch();
  const changed = { ...original, events: [{ ...original.events[0], value: 100 }] };
  expect(await digestBrowserEventFacts(original, 1)).toBe(
    await digestBrowserEventFacts(changed, 1),
  );
  expect(await digestBrowserEventFacts(original, 2)).not.toBe(
    await digestBrowserEventFacts(changed, 2),
  );
  expect(() => serializeBrowserEventFacts(original, 3)).toThrow('Unsupported');
  const prepared = await prepareBrowserBatch(original, 'raw-session', false);
  expect(prepared).toMatchObject({ facts_digest_version: 2 });
  expect(prepared.session_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(prepared)).not.toContain('raw-session');
  expect(await prepareBrowserBatch(original, undefined, true)).toBe(original);
  expect(
    await prepareBrowserBatch({ ...original, events: [] }, undefined, false),
  ).not.toHaveProperty('facts_digest');
  await expect(
    claimBrowserBatch(
      {
        prepare: () => {
          throw new Error('unavailable');
        },
        batch: async () => [],
      },
      original,
    ),
  ).rejects.toThrow();
});
