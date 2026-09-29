import { describe, expect, it } from 'vitest';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import {
  reconcileBrowserArchiveDay,
  type BrowserArchiveReconciliationInput,
} from '../src/browser-archive-reconciliation.js';

const day = '2026-09-29';
const timestamp = Date.parse('2026-09-29T18:00:00Z');

function batch(overrides: Partial<CollectedBrowserBatch> = {}): CollectedBrowserBatch {
  return {
    workspace: 'workspace-a',
    app_id: 'app-a',
    environment_id: 'production',
    batch_id: 'batch-a',
    received_at: Date.parse('2026-09-30T12:00:00Z'),
    visitor_hash: 'a'.repeat(64),
    events: [{ event_id: 'event-a', timestamp, type: 'pageview', path: '/', referrer: '' }],
    ...overrides,
  };
}

async function readyInput(
  item = batch(),
  overrides: Partial<BrowserArchiveReconciliationInput> = {},
): Promise<BrowserArchiveReconciliationInput> {
  const digest = await digestBrowserEventFacts(item);
  return {
    day,
    workspace: 'workspace-a',
    receipts: [
      {
        app_id: item.app_id,
        environment_id: item.environment_id,
        batch_id: item.batch_id,
        facts_digest_version: 1,
        facts_digest: digest,
      },
    ],
    archived: [{ ...item, facts_digest_version: 1, facts_digest: digest }],
    receipt_pages_complete: true,
    archive_lookup_complete: true,
    r2_retention: 'available',
    d1_retention: 'available',
    queue: 'reconciled',
    dlq: 'reconciled',
    ...overrides,
  };
}

describe('offline browser archive day reconciliation', () => {
  it('matches a late archived event by event day, independent of upload/receipt time', async () => {
    const item = batch({
      received_at: Date.parse('2026-10-01T08:00:00Z'),
      events: [
        { event_id: 'late-event', timestamp, type: 'pageview', path: '/late', referrer: '' },
      ],
    });
    const digest = await digestBrowserEventFacts(item);
    const result = await reconcileBrowserArchiveDay(
      await readyInput(item, {
        receipts: [
          {
            app_id: item.app_id,
            environment_id: item.environment_id,
            batch_id: item.batch_id,
            facts_digest_version: 1,
            facts_digest: digest,
          },
        ],
      }),
    );
    expect(result).toMatchObject({ day, complete: true, rows: [{ state: 'matched' }] });
  });

  it('reports changed archived facts as a digest mismatch', async () => {
    const accepted = batch();
    const acceptedDigest = await digestBrowserEventFacts(accepted);
    const changed = batch({
      events: [
        {
          ...accepted.events[0]!,
          timestamp: Date.parse('2026-10-01T00:00:00Z'),
          path: '/changed',
        },
      ],
    });
    const changedDigest = await digestBrowserEventFacts(changed);
    const result = await reconcileBrowserArchiveDay(
      await readyInput(accepted, {
        archived: [{ ...changed, facts_digest_version: 1, facts_digest: changedDigest }],
      }),
    );
    expect(result.complete).toBe(false);
    expect(result.rows).toMatchObject([{ state: 'digest_mismatch' }]);
    expect(result.incomplete_reasons).toContain('digest_mismatch');
    expect(changedDigest).not.toBe(acceptedDigest);
  });

  it('keeps missing archive, legacy receipt, expired retention, and unproven Queue/DLQ explicitly incomplete', async () => {
    const legacy = await readyInput(batch({ batch_id: 'legacy' }), {
      receipts: [
        {
          app_id: 'app-a',
          environment_id: 'production',
          batch_id: 'legacy',
          facts_digest_version: null,
          facts_digest: null,
        },
      ],
    });
    const result = await reconcileBrowserArchiveDay({
      ...legacy,
      archived: [],
      receipt_pages_complete: false,
      archive_lookup_complete: false,
      r2_retention: 'expired',
      d1_retention: 'expired',
      queue: 'unknown',
      dlq: 'pending',
    });
    expect(result.complete).toBe(false);
    expect(result.rows).toMatchObject([{ state: 'legacy_receipt' }]);
    expect(result.incomplete_reasons).toEqual(
      expect.arrayContaining([
        'legacy_receipt',
        'receipt_pages_incomplete',
        'archive_lookup_incomplete',
        'd1_retention_expired',
        'r2_retention_expired',
        'queue_unknown',
        'dlq_pending',
      ]),
    );
  });

  it('does not certify an archived-only fact when the D1 receipt is absent', async () => {
    const item = batch();
    const digest = await digestBrowserEventFacts(item);
    const result = await reconcileBrowserArchiveDay({
      ...(await readyInput(item)),
      receipts: [],
      archived: [{ ...item, facts_digest_version: 1, facts_digest: digest }],
    });
    expect(result.complete).toBe(false);
    expect(result.rows).toMatchObject([{ state: 'archive_without_d1_receipt' }]);
  });
});
