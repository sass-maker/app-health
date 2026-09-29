import { ArchiveSegmentManifestV1 } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import { reconcileBrowserArchiveDay } from './browser-archive-reconciliation.js';
import {
  readBrowserVisitorReceiptPage,
  type BrowserVisitorReceiptCursor,
  type ExactBrowserVisitorScope,
} from './browser-visitor-daily.js';
import type { D1DatabaseLike } from './d1-adapter.js';

const SHARD_COUNT = 16;
const RECEIPT_SCOPE_LIMIT = 128;
const RECEIPT_PAGE_SIZE = 500;
const RECEIPT_LIMIT = 10_000;
const RECEIPT_PAGE_LIMIT = Math.ceil(RECEIPT_LIMIT / RECEIPT_PAGE_SIZE);
const SHARD_PAGE_SIZE = 100;
const SHARD_PAGE_LIMIT = 100;
const SEGMENT_LIMIT = 5_000;
const BATCH_INDEX_LOOKUP_LIMIT = 100;
const BATCH_INDEX_LOOKUP_CONCURRENCY = 25;
const SEGMENT_BYTES_LIMIT = 64 * 1024 * 1024;
const SEGMENT_BYTES_MAX = 2 * 1024 * 1024;
const DECOMPRESSED_BYTES_LIMIT = 8 * 1024 * 1024;
const DECOMPRESSED_BYTES_MAX = 2 * 1024 * 1024;
const ARCHIVE_FACT_LIMIT = 10_000;

type DayCursor = { event_day: string; object_key: string; snapshot_sequence: number };
type SegmentReference = { segment_id: string; object_key: string };
type DayPage = {
  segments: SegmentReference[];
  next_cursor: DayCursor | null;
  snapshot_sequence: number;
};
type BatchReference = SegmentReference;

type BrowserArchiveDayAuditArchive = {
  getByName(name: string): {
    archiveSegmentsForEventDay(
      day: string,
      cursor: DayCursor | null,
      limit: number,
    ): Promise<DayPage>;
    archiveSegmentForBatch(
      appId: string,
      environmentId: string,
      batchId: string,
    ): Promise<BatchReference | null>;
  };
};

export type BrowserArchiveDayAuditInput = {
  db: D1DatabaseLike;
  workspace: string;
  day: string;
  archive: BrowserArchiveDayAuditArchive;
  history: Pick<R2Bucket, 'get'>;
};

export type BrowserArchiveDayAudit = {
  day: string;
  complete: false;
  matched: number;
  mismatched: number;
  missing_archive: number;
  legacy: number;
  archive_only: number;
  duplicate_archive: number;
  missing_archive_digest: number;
  receipt_count: number;
  segment_count: number;
  shards_exhausted: number;
  incomplete_reasons: string[];
};

function safeDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function cappedReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('8 MiB serialized-byte cap')) return 'comparison_byte_cap';
  if (message.includes('25-event batch limit')) return 'invalid_archive_batch';
  return 'comparison_failed';
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('segment byte cap');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isArchiveBatch(value: unknown, workspace: string): value is CollectedBrowserBatch {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CollectedBrowserBatch>;
  return (
    row.workspace === workspace &&
    typeof row.app_id === 'string' &&
    row.app_id.length > 0 &&
    typeof row.environment_id === 'string' &&
    row.environment_id.length > 0 &&
    typeof row.batch_id === 'string' &&
    row.batch_id.length > 0 &&
    Array.isArray(row.events) &&
    row.events.length > 0 &&
    row.events.length <= 25 &&
    row.events.every(isArchiveEvent)
  );
}

function isArchiveEvent(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const row = event as Partial<CollectedBrowserBatch['events'][number]>;
  return (
    typeof row.event_id === 'string' &&
    typeof row.type === 'string' &&
    typeof row.path === 'string' &&
    typeof row.referrer === 'string' &&
    Number.isSafeInteger(row.timestamp) &&
    row.timestamp! >= 0
  );
}

async function readVerifiedSegment(
  input: BrowserArchiveDayAuditInput,
  reference: SegmentReference,
  byteState: { compressed: number; decompressed: number },
): Promise<CollectedBrowserBatch[]> {
  const object = await input.history.get(reference.object_key);
  if (!object) throw new Error('missing segment');
  try {
    const { compressed, manifest } = await readCompressedSegment(
      input,
      reference,
      object,
      byteState,
    );
    return await parseSegmentFacts(input.workspace, compressed, manifest, byteState);
  } finally {
    await object.body.cancel().catch(() => undefined);
  }
}

async function readCompressedSegment(
  input: BrowserArchiveDayAuditInput,
  reference: SegmentReference,
  object: R2ObjectBody,
  byteState: { compressed: number; decompressed: number },
) {
  if (object.size < 1 || object.size > SEGMENT_BYTES_MAX) throw new Error('segment byte cap');
  byteState.compressed += object.size;
  if (byteState.compressed > SEGMENT_BYTES_LIMIT) throw new Error('global segment byte cap');
  const manifestValue = object.customMetadata?.manifest;
  if (!manifestValue) throw new Error('missing manifest');
  const manifest = ArchiveSegmentManifestV1.parse(JSON.parse(manifestValue));
  if (
    manifest.object_key !== reference.object_key ||
    manifest.workspace_id !== input.workspace ||
    manifest.format !== 'jsonl-gzip' ||
    manifest.state !== 'active' ||
    manifest.compressed_bytes !== object.size
  )
    throw new Error('manifest mismatch');
  const compressed = await readBoundedBody(object.body, SEGMENT_BYTES_MAX);
  const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', compressed));
  const checksumHex = [...checksum].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (checksumHex !== manifest.content_sha256) throw new Error('checksum mismatch');
  return { compressed, manifest };
}

async function parseSegmentFacts(
  workspace: string,
  compressed: Uint8Array,
  manifest: ReturnType<typeof ArchiveSegmentManifestV1.parse>,
  byteState: { compressed: number; decompressed: number },
): Promise<CollectedBrowserBatch[]> {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = await readBoundedBody(stream as ReadableStream<Uint8Array>, DECOMPRESSED_BYTES_MAX);
  byteState.decompressed += raw.byteLength;
  if (byteState.decompressed > DECOMPRESSED_BYTES_LIMIT) throw new Error('global decompressed cap');
  if (raw.byteLength !== manifest.uncompressed_bytes) throw new Error('manifest length mismatch');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  const lines = text.trimEnd().split('\n');
  if (!text.endsWith('\n') || lines.length !== manifest.row_count)
    throw new Error('manifest row mismatch');
  return validateSegmentRows(lines, workspace, manifest);
}

function validateSegmentRows(
  lines: string[],
  workspace: string,
  manifest: ReturnType<typeof ArchiveSegmentManifestV1.parse>,
): CollectedBrowserBatch[] {
  const batches: CollectedBrowserBatch[] = [];
  const bounds = { count: 0, minimum: Infinity, maximum: -Infinity };
  for (const line of lines) {
    const parsed: unknown = JSON.parse(line);
    if (!isArchiveBatch(parsed, workspace)) throw new Error('invalid archive batch');
    for (const event of parsed.events) {
      bounds.count++;
      bounds.minimum = Math.min(bounds.minimum, event.timestamp);
      bounds.maximum = Math.max(bounds.maximum, event.timestamp);
    }
    batches.push(parsed);
  }
  if (
    bounds.count !== manifest.event_count ||
    bounds.minimum !== manifest.min_event_at ||
    bounds.maximum !== manifest.max_event_at
  )
    throw new Error('manifest facts mismatch');
  return batches;
}

async function receiptScopes(
  db: D1DatabaseLike,
  workspace: string,
  day: string,
): Promise<{ scopes: ExactBrowserVisitorScope[]; capped: boolean }> {
  const result = await db
    .prepare(
      `SELECT DISTINCT app_id, environment_id
     FROM browser_visitor_receipt_days
     WHERE workspace_id = ? AND india_day = ?
     ORDER BY app_id, environment_id
     LIMIT ?`,
    )
    .bind(workspace, day, RECEIPT_SCOPE_LIMIT + 1)
    .all<ExactBrowserVisitorScope>();
  const capped = result.results.length > RECEIPT_SCOPE_LIMIT;
  return { scopes: result.results.slice(0, RECEIPT_SCOPE_LIMIT), capped };
}

async function shardForReceipt(
  workspace: string,
  receipt: { app_id: string; environment_id: string; batch_id: string },
): Promise<string> {
  const identity = JSON.stringify([receipt.app_id, receipt.environment_id, receipt.batch_id]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return `${workspace}:browser-archive-v1:${new Uint8Array(digest)[0]! % SHARD_COUNT}`;
}

function countStates(rows: readonly { state: string }[]) {
  const counts = {
    matched: 0,
    mismatched: 0,
    missing_archive: 0,
    legacy: 0,
    archive_only: 0,
    duplicate_archive: 0,
    missing_archive_digest: 0,
  };
  for (const { state } of rows) {
    if (state === 'matched') counts.matched++;
    else if (state === 'digest_mismatch') counts.mismatched++;
    else if (state === 'missing_archive_fact') counts.missing_archive++;
    else if (state === 'legacy_receipt') counts.legacy++;
    else if (state === 'archive_without_d1_receipt') counts.archive_only++;
    else if (state === 'duplicate_archive_fact') counts.duplicate_archive++;
    else if (state === 'archive_digest_missing') counts.missing_archive_digest++;
  }
  return counts;
}

type AuditState = {
  reasons: Set<string>;
  receipts: Array<{
    app_id: string;
    environment_id: string;
    batch_id: string;
    facts_digest_version: number | null;
    facts_digest: string | null;
  }>;
  receiptPagesComplete: boolean;
  references: Map<string, SegmentReference>;
  processedReferences: Set<string>;
  batchLookupSkipped: Set<string>;
  shardsExhausted: number;
  archiveLookupComplete: boolean;
  archived: CollectedBrowserBatch[];
  byteState: { compressed: number; decompressed: number };
  archiveFactsComplete: boolean;
};

function newAuditState(): AuditState {
  return {
    reasons: new Set([
      'queue_evidence_unavailable',
      'dlq_evidence_unavailable',
      'd1_retention_unverified',
      'r2_retention_unverified',
      'snapshot_is_not_current_state_barrier',
    ]),
    receipts: [],
    receiptPagesComplete: false,
    references: new Map(),
    processedReferences: new Set(),
    batchLookupSkipped: new Set(),
    shardsExhausted: 0,
    archiveLookupComplete: true,
    archived: [],
    byteState: { compressed: 0, decompressed: 0 },
    archiveFactsComplete: true,
  };
}

async function readReceipts(input: BrowserArchiveDayAuditInput, state: AuditState): Promise<void> {
  try {
    const selected = await receiptScopes(input.db, input.workspace, input.day);
    if (selected.capped) {
      state.reasons.add('receipt_scope_cap');
      return;
    }
    state.receiptPagesComplete = true;
    let cursor: BrowserVisitorReceiptCursor | undefined;
    for (let pageNumber = 0; pageNumber < RECEIPT_PAGE_LIMIT; pageNumber++) {
      const page = await readBrowserVisitorReceiptPage(
        input.db,
        input.workspace,
        selected.scopes,
        input.day,
        RECEIPT_PAGE_SIZE,
        cursor,
      );
      if (state.receipts.length + page.receipts.length > RECEIPT_LIMIT) {
        state.receiptPagesComplete = false;
        state.reasons.add('receipt_fact_cap');
        break;
      }
      state.receipts.push(
        ...page.receipts.map((row) => ({
          app_id: row.app_id,
          environment_id: row.environment_id,
          batch_id: row.batch_id,
          facts_digest_version: row.facts_digest_version,
          facts_digest: row.facts_digest,
        })),
      );
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
      if (pageNumber === RECEIPT_PAGE_LIMIT - 1) {
        state.receiptPagesComplete = false;
        state.reasons.add('receipt_page_cap');
      }
    }
  } catch {
    state.reasons.add('receipt_read_failed');
  }
}

function addReference(state: AuditState, reference: SegmentReference): void {
  if (!reference || typeof reference.object_key !== 'string' || reference.object_key.length > 1024)
    throw new Error('invalid reference');
  if (!state.references.has(reference.object_key) && state.references.size >= SEGMENT_LIMIT)
    throw new Error('segment cap');
  state.references.set(reference.object_key, reference);
}

async function readOneShard(input: BrowserArchiveDayAuditInput, state: AuditState, shard: number) {
  let cursor: DayCursor | null = null;
  let snapshotSequence: number | undefined;
  for (let pageNumber = 0; pageNumber < SHARD_PAGE_LIMIT; pageNumber++) {
    const stub = input.archive.getByName(`${input.workspace}:browser-archive-v1:${shard}`);
    const page = await stub.archiveSegmentsForEventDay(input.day, cursor, SHARD_PAGE_SIZE);
    if (!Number.isSafeInteger(page.snapshot_sequence) || page.snapshot_sequence < 0)
      throw new Error('invalid snapshot');
    if (snapshotSequence === undefined) snapshotSequence = page.snapshot_sequence;
    else if (snapshotSequence !== page.snapshot_sequence) throw new Error('snapshot changed');
    for (const reference of page.segments) addReference(state, reference);
    if (!page.next_cursor) return true;
    if (
      page.next_cursor.event_day !== input.day ||
      page.next_cursor.snapshot_sequence !== snapshotSequence ||
      page.next_cursor.object_key === cursor?.object_key
    )
      throw new Error('invalid cursor');
    cursor = page.next_cursor;
    if (pageNumber === SHARD_PAGE_LIMIT - 1) state.reasons.add('shard_page_cap');
  }
  return false;
}

async function readShardIndexes(
  input: BrowserArchiveDayAuditInput,
  state: AuditState,
): Promise<void> {
  for (let shard = 0; shard < SHARD_COUNT; shard++) {
    try {
      if (await readOneShard(input, state, shard)) state.shardsExhausted++;
      else state.archiveLookupComplete = false;
    } catch (error) {
      state.archiveLookupComplete = false;
      state.reasons.add(
        error instanceof Error && error.message === 'segment cap'
          ? 'segment_cap'
          : 'shard_index_read_failed',
      );
    }
  }
}

async function readBatchIndexes(
  input: BrowserArchiveDayAuditInput,
  state: AuditState,
): Promise<void> {
  if (!state.receiptPagesComplete) {
    state.archiveLookupComplete = false;
    return;
  }
  const skipped = state.receipts.slice(BATCH_INDEX_LOOKUP_LIMIT);
  if (skipped.length > 0) {
    state.archiveLookupComplete = false;
    state.reasons.add('batch_index_cap');
    for (const receipt of skipped) state.batchLookupSkipped.add(receiptKey(receipt));
  }
  const selected = state.receipts.slice(0, BATCH_INDEX_LOOKUP_LIMIT);
  for (let start = 0; start < selected.length; start += BATCH_INDEX_LOOKUP_CONCURRENCY) {
    const chunk = selected.slice(start, start + BATCH_INDEX_LOOKUP_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async (receipt) => {
        const shardName = await shardForReceipt(input.workspace, receipt);
        return input.archive
          .getByName(shardName)
          .archiveSegmentForBatch(receipt.app_id, receipt.environment_id, receipt.batch_id);
      }),
    );
    for (const [index, result] of results.entries()) {
      const receipt = chunk[index]!;
      if (result.status === 'rejected') {
        state.archiveLookupComplete = false;
        state.batchLookupSkipped.add(receiptKey(receipt));
        state.reasons.add('batch_index_read_failed');
      } else if (result.value) {
        try {
          addReference(state, result.value);
        } catch {
          state.archiveLookupComplete = false;
          state.batchLookupSkipped.add(receiptKey(receipt));
          state.reasons.add('segment_cap');
        }
      }
    }
  }
}

function receiptKey(receipt: { app_id: string; environment_id: string; batch_id: string }): string {
  return JSON.stringify([receipt.app_id, receipt.environment_id, receipt.batch_id]);
}

function segmentFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'segment byte cap' || message === 'global segment byte cap') return 'r2_byte_cap';
  if (message === 'global decompressed cap' || message === 'archive fact cap')
    return 'archive_fact_cap';
  if (message === 'missing segment') return 'r2_object_missing';
  if (message === 'missing manifest') return 'r2_manifest_missing';
  return 'r2_segment_verification_failed';
}

async function acquireArchiveFacts(
  input: BrowserArchiveDayAuditInput,
  state: AuditState,
): Promise<void> {
  for (const reference of state.references.values()) {
    if (state.processedReferences.has(reference.object_key)) continue;
    state.processedReferences.add(reference.object_key);
    try {
      const batches = await readVerifiedSegment(input, reference, state.byteState);
      if (state.archived.length + batches.length > ARCHIVE_FACT_LIMIT)
        throw new Error('archive fact cap');
      state.archived.push(...batches);
    } catch (error) {
      state.archiveFactsComplete = false;
      state.archiveLookupComplete = false;
      state.reasons.add(segmentFailureReason(error));
      break;
    }
  }
  if (!state.archiveFactsComplete) state.reasons.add('archive_facts_incomplete');
}

function addComparisonReasons(state: AuditState, reasons: readonly string[]): void {
  const visible = new Set([
    'receipt_pages_incomplete',
    'archive_lookup_incomplete',
    'legacy_receipt',
    'missing_archive_fact',
    'archive_digest_missing',
    'digest_mismatch',
    'duplicate_archive_fact',
    'archive_without_d1_receipt',
  ]);
  for (const reason of reasons) if (visible.has(reason)) state.reasons.add(reason);
}

async function compareFacts(input: BrowserArchiveDayAuditInput, state: AuditState) {
  try {
    const archived = state.archived.filter(
      (batch) => !state.batchLookupSkipped.has(receiptKey(batch)),
    );
    const comparison = await reconcileBrowserArchiveDay({
      day: input.day,
      workspace: input.workspace,
      receipts: state.receipts,
      archived,
      receipt_pages_complete: state.receiptPagesComplete,
      archive_lookup_complete:
        state.archiveLookupComplete &&
        state.archiveFactsComplete &&
        state.shardsExhausted === SHARD_COUNT,
      r2_retention: 'unknown',
      d1_retention: 'unknown',
      queue: 'unknown',
      dlq: 'unknown',
    });
    addComparisonReasons(state, comparison.incomplete_reasons);
    return countStates(comparison.rows);
  } catch (error) {
    state.reasons.add(cappedReason(error));
    return countStates([]);
  }
}

/**
 * Acquire bounded offline evidence for one India day. This is intentionally
 * never a coverage certificate: Queue/DLQ and retention evidence are unknown,
 * and stable index snapshots do not prove current-state completeness.
 */
export async function auditBrowserArchiveDay(
  input: BrowserArchiveDayAuditInput,
): Promise<BrowserArchiveDayAudit> {
  if (!safeDay(input.day) || !input.workspace || input.workspace.length > 100)
    throw new Error('Invalid browser archive audit scope');
  const state = newAuditState();
  await readReceipts(input, state);
  await readShardIndexes(input, state);
  await readBatchIndexes(input, state);
  await acquireArchiveFacts(input, state);
  const counts = await compareFacts(input, state);
  return {
    day: input.day,
    complete: false,
    ...counts,
    receipt_count: state.receipts.length,
    segment_count: state.references.size,
    shards_exhausted: state.shardsExhausted,
    incomplete_reasons: [...state.reasons].sort(),
  };
}
