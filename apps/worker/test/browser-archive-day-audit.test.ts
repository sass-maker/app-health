import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import { auditBrowserArchiveDay } from '../src/browser-archive-day-audit.js';

const day = '2026-09-29';
const workspace = 'workspace-a';
const batch: CollectedBrowserBatch = {
  workspace,
  app_id: 'app-private-id',
  environment_id: 'environment-private-id',
  batch_id: 'batch-private-id',
  received_at: Date.parse('2026-09-30T01:00:00Z'),
  visitor_hash: 'a'.repeat(64),
  events: [
    {
      event_id: 'event-private-id',
      timestamp: Date.parse('2026-09-29T18:00:00Z'),
      type: 'pageview',
      path: '/private-path',
      referrer: '',
    },
  ],
};
const objectKey = 'browser/workspace-a/2026/09/30/segment-a.jsonl.gz';

async function fixture(
  options: {
    manifest?: boolean;
    corrupt?: boolean;
    dayIndex?: boolean;
    archivedTimestamp?: number;
    overflowStream?: boolean;
    receiptCount?: number;
  } = {},
) {
  const digest = await digestBrowserEventFacts(batch);
  const archivedBatch =
    options.archivedTimestamp === undefined
      ? batch
      : { ...batch, events: [{ ...batch.events[0]!, timestamp: options.archivedTimestamp }] };
  const archivedDigest = await digestBrowserEventFacts(archivedBatch);
  const archived = { ...archivedBatch, facts_digest_version: 1, facts_digest: archivedDigest };
  const receiptRows = Array.from({ length: options.receiptCount ?? 1 }, (_, index) => {
    const receiptBatchId =
      index === 0 ? batch.batch_id : `z-batch-${String(index).padStart(4, '0')}`;
    return {
      app_id: batch.app_id,
      environment_id: batch.environment_id,
      batch_id: receiptBatchId,
      fingerprint: 'f'.repeat(64),
      accepted_at: batch.received_at,
      event_count: 1,
      facts_digest_version: 1,
      facts_digest: index === 0 ? digest : 'e'.repeat(64),
    };
  });
  const raw = Buffer.from(`${JSON.stringify(archived)}\n`);
  const compressed = gzipSync(raw);
  const checksum = createHash('sha256').update(compressed).digest('hex');
  const manifest = {
    schema_version: 1,
    object_key: objectKey,
    workspace_id: workspace,
    format: 'jsonl-gzip',
    content_sha256: options.corrupt ? '0'.repeat(64) : checksum,
    row_count: 1,
    event_count: 1,
    min_event_at: archivedBatch.events[0]!.timestamp,
    max_event_at: archivedBatch.events[0]!.timestamp,
    uncompressed_bytes: raw.byteLength,
    compressed_bytes: options.overflowStream ? 1 : compressed.byteLength,
    created_at: Date.now(),
    state: 'active',
  };
  const shardNames: string[] = [];
  const dayReads: number[] = [];
  const batchReads: string[] = [];
  let overflowCancelled = false;
  const db = {
    prepare(query: string) {
      const bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bindings.push(...values);
          return statement;
        },
        async all<T>() {
          if (query.includes('SELECT DISTINCT app_id, environment_id'))
            return {
              results: [{ app_id: batch.app_id, environment_id: batch.environment_id }] as T[],
            };
          if (query.includes('FROM requested')) {
            const after = typeof bindings[5] === 'string' ? bindings[5] : undefined;
            const limit = Number(bindings.at(-1));
            return {
              results: receiptRows
                .filter((row) => !after || row.batch_id > after)
                .slice(0, limit) as T[],
            };
          }
          throw new Error('unexpected D1 query');
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  } as never;
  const reference = { segment_id: 'segment-private-id', object_key: objectKey };
  const archive = {
    getByName(name: string) {
      shardNames.push(name);
      return {
        async archiveSegmentsForEventDay(_value: string, _cursor: unknown, _limit: number) {
          const shard = Number(name.split(':').at(-1));
          dayReads.push(shard);
          return {
            segments: shard === 0 && options.dayIndex !== false ? [reference] : [],
            next_cursor: null,
            snapshot_sequence: 7,
          };
        },
        async archiveSegmentForBatch(appId: string, environmentId: string, batchId: string) {
          batchReads.push([appId, environmentId, batchId].join('/'));
          return reference;
        },
      };
    },
  };
  const history = {
    async get() {
      const body = options.overflowStream
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(3 * 1024 * 1024));
            },
            cancel() {
              overflowCancelled = true;
            },
          })
        : new Response(compressed).body!;
      return {
        size: options.overflowStream ? 1 : compressed.byteLength,
        customMetadata: options.manifest === false ? {} : { manifest: JSON.stringify(manifest) },
        body,
      };
    },
  } as never;
  return {
    input: { db, workspace, day, archive, history },
    observations: {
      shardNames,
      dayReads,
      batchReads,
      isOverflowCancelled: () => overflowCancelled,
    },
  };
}

describe('offline browser archive day auditor', () => {
  it('pages every shard, follows batch indexes, verifies R2, and returns only aggregate facts', async () => {
    const setup = await fixture();
    const result = await auditBrowserArchiveDay(setup.input);
    expect(setup.observations.dayReads).toEqual(Array.from({ length: 16 }, (_, index) => index));
    expect(setup.observations.shardNames).toHaveLength(17);
    expect(setup.observations.batchReads).toEqual([
      'app-private-id/environment-private-id/batch-private-id',
    ]);
    expect(result).toMatchObject({
      complete: false,
      matched: 1,
      receipt_count: 1,
      segment_count: 1,
      shards_exhausted: 16,
    });
    expect(result.incomplete_reasons).toEqual(
      expect.arrayContaining([
        'queue_evidence_unavailable',
        'dlq_evidence_unavailable',
        'd1_retention_unverified',
        'r2_retention_unverified',
        'snapshot_is_not_current_state_barrier',
      ]),
    );
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      batch.visitor_hash,
      batch.app_id,
      batch.environment_id,
      batch.batch_id,
      batch.events[0]!.event_id,
      batch.events[0]!.path,
      objectKey,
    ])
      expect(serialized).not.toContain(privateValue);
  });

  it('reports missing manifest and corrupt bytes as incomplete without returning archive identifiers', async () => {
    for (const options of [{ manifest: false }, { corrupt: true }]) {
      const setup = await fixture(options);
      const result = await auditBrowserArchiveDay(setup.input);
      expect(result.complete).toBe(false);
      expect(result.incomplete_reasons).toContain('archive_facts_incomplete');
      expect(JSON.stringify(result)).not.toContain('segment-private-id');
    }
  });

  it('uses the batch index for a fact whose archived timestamp moved outside the selected India day', async () => {
    const setup = await fixture({
      dayIndex: false,
      archivedTimestamp: Date.parse('2026-09-30T00:00:00Z'),
    });
    const result = await auditBrowserArchiveDay(setup.input);
    expect(setup.observations.batchReads).toHaveLength(1);
    expect(result.mismatched).toBe(1);
    expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('cancels an oversized stream and reports a bounded R2 read failure', async () => {
    const setup = await fixture({ overflowStream: true });
    const result = await auditBrowserArchiveDay(setup.input);
    expect(setup.observations.isOverflowCancelled()).toBe(true);
    expect(result.incomplete_reasons).toContain('r2_byte_cap');
    expect(result.complete).toBe(false);
  });

  it('caps fallback batch-index lookups and reports skipped identities incomplete', async () => {
    const setup = await fixture({ receiptCount: 101 });
    const result = await auditBrowserArchiveDay(setup.input);
    expect(setup.observations.batchReads).toHaveLength(100);
    expect(result.incomplete_reasons).toContain('batch_index_cap');
    expect(result.matched).toBe(1);
    expect(result.missing_archive).toBe(100);
    expect(result.complete).toBe(false);
  });
});
