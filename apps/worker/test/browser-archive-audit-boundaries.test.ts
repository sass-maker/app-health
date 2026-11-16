import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readBrowserArchiveAuditSegment } from '../src/browser-archive-day-audit.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const workspace = 'archive-boundary-test';
const timestamp = Date.parse('2026-11-12T10:00:00Z');
const reference = {
  segment_id: 'segment',
  object_key: 'browser-v2/2026-11-12/archive-shard-a/segment.jsonl.gz',
};
const batch: CollectedBrowserBatch = {
  workspace,
  app_id: 'app',
  environment_id: 'production',
  batch_id: 'batch',
  received_at: timestamp,
  events: [{ event_id: 'event', timestamp, type: 'pageview', path: '/', referrer: '' }],
};

async function readRows(rows: CollectedBrowserBatch[]) {
  const raw = Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const compressed = gzipSync(raw);
  const manifest = {
    schema_version: 1,
    object_key: reference.object_key,
    workspace_id: workspace,
    format: 'jsonl-gzip',
    state: 'active',
    created_at: timestamp,
    content_sha256: createHash('sha256').update(compressed).digest('hex'),
    row_count: rows.length,
    event_count: rows.reduce((n, row) => n + row.events.length, 0),
    min_event_at: timestamp,
    max_event_at: timestamp,
    uncompressed_bytes: raw.length,
    compressed_bytes: compressed.length,
  };
  return readBrowserArchiveAuditSegment(
    {
      workspace,
      history: {
        get: async () =>
          ({
            body: new Response(compressed).body!,
            size: compressed.length,
            customMetadata: { manifest: JSON.stringify(manifest) },
          }) as unknown as R2ObjectBody,
      },
    },
    reference,
    { compressed: 0, decompressed: 0 },
  );
}

function sizedRow(bytes: number, unicode: boolean) {
  const row = { ...batch, padding: '' };
  const remaining = bytes - Buffer.byteLength(`${JSON.stringify(row)}\n`);
  row.padding = unicode
    ? '₹'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3)
    : 'x'.repeat(remaining);
  expect(Buffer.byteLength(`${JSON.stringify(row)}\n`)).toBe(bytes);
  return row;
}

describe('archive producer record boundary', () => {
  it.each([false, true])(
    'accepts exact newline-inclusive 64 KiB UTF-8 records (unicode=%s)',
    async (unicode) => {
      expect((await readRows([sizedRow(65_536, unicode)])).batches).toHaveLength(1);
    },
  );
  it.each([false, true])(
    'rejects a record one byte above the producer boundary (unicode=%s)',
    async (unicode) => {
      await expect(readRows([sizedRow(65_537, unicode)])).rejects.toMatchObject({
        reason: 'object_limit',
      });
    },
  );
  it('rejects an oversized malformed JSON record before parsing it', async () => {
    const row = { ...batch, padding: '['.repeat(70_000) };
    await expect(readRows([row])).rejects.toThrow('archive record byte cap');
  });
  it('retains historical no-digest, V1 and expanded V2 records without a new schema gate', async () => {
    const v1 = {
      ...batch,
      batch_id: 'v1',
      session_hash: 'a'.repeat(64),
      visitor_hash: 'b'.repeat(64),
      facts_digest_version: 1 as const,
    };
    const v2 = {
      ...v1,
      batch_id: 'v2',
      facts_digest_version: 2 as const,
      events: [
        {
          ...batch.events[0]!,
          type: 'event' as const,
          name: 'purchase',
          properties: { plan: 'pro', seats: 2 },
          value: 29,
        },
      ],
      attribution: {
        source: 'launch',
        medium: '',
        campaign: '',
        content: '',
        term: '',
        entry_path: '/',
      },
    };
    const rows = [
      batch,
      { ...v1, facts_digest: await digestBrowserEventFacts(v1) },
      { ...v2, facts_digest: await digestBrowserEventFacts(v2) },
    ];
    expect((await readRows(rows)).batches).toEqual(rows);
  });
});
