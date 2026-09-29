import type { CollectedBrowserBatch } from './browser-analytics.js';
import {
  BROWSER_EVENT_FACTS_DIGEST_VERSION,
  digestSerializedBrowserEventFacts,
  serializeBrowserEventFacts,
} from './browser-facts-digest.js';
import { indiaDayForTimestamp } from './browser-visitor-daily.js';

const MAX_BROWSER_ARCHIVE_RECONCILIATION_FACTS = 10_000;
const MAX_BROWSER_ARCHIVE_RECONCILIATION_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_ARCHIVE_BATCH_BYTES = 64 * 1024;
const MAX_BROWSER_ARCHIVE_BATCH_EVENTS = 25;

/** A parsed immutable R2 row. The caller must verify its segment manifest and bytes first. */
type BrowserArchiveFact = Pick<
  CollectedBrowserBatch,
  'workspace' | 'app_id' | 'environment_id' | 'batch_id' | 'events' | 'visitor_hash'
> & { facts_digest_version?: number; facts_digest?: string };

type BrowserArchiveReconciliationState =
  | 'matched'
  | 'missing_archive_fact'
  | 'legacy_receipt'
  | 'archive_digest_missing'
  | 'digest_mismatch'
  | 'duplicate_archive_fact'
  | 'archive_without_d1_receipt';

type BrowserArchiveReconciliationRow = {
  app_id: string;
  environment_id: string;
  batch_id: string;
  state: BrowserArchiveReconciliationState;
};

export type BrowserArchiveReconciliationInput = {
  day: string;
  workspace: string;
  receipts: readonly {
    app_id: string;
    environment_id: string;
    batch_id: string;
    facts_digest_version: number | null;
    facts_digest: string | null;
  }[];
  archived: readonly BrowserArchiveFact[];
  /** True only after the D1 selector returned every page through a null cursor. */
  receipt_pages_complete: boolean;
  /** False when the bounded day→R2 lookup stopped at its work cap or missed a page. */
  archive_lookup_complete: boolean;
  /** Provider lifecycle evidence for all R2 objects relevant to this day. */
  r2_retention: 'available' | 'expired' | 'unknown';
  d1_retention: 'available' | 'expired' | 'unknown';
  queue: 'reconciled' | 'pending' | 'unknown';
  dlq: 'reconciled' | 'pending' | 'unknown';
};

export type BrowserArchiveReconciliation = {
  day: string;
  complete: boolean;
  rows: BrowserArchiveReconciliationRow[];
  incomplete_reasons: string[];
};

const identity = (fact: { app_id: string; environment_id: string; batch_id: string }) =>
  JSON.stringify([fact.app_id, fact.environment_id, fact.batch_id]);
const digestPattern = /^[a-f0-9]{64}$/;

function batchStringCodeUnits(batch: BrowserArchiveFact): number {
  const values = [batch.workspace, batch.app_id, batch.environment_id, batch.batch_id];
  if (batch.visitor_hash !== undefined) values.push(batch.visitor_hash);
  for (const event of batch.events) {
    values.push(event.event_id, event.type, event.path, event.referrer);
    if (event.name !== undefined) values.push(event.name);
  }
  if (values.some((value) => typeof value !== 'string'))
    throw new Error('Invalid archive fact string field');
  return values.reduce((sum, value) => sum + value.length, 0);
}

type ReceiptMap = Map<string, BrowserArchiveReconciliationInput['receipts'][number]>;
type ArchiveCandidate = { batch: BrowserArchiveFact; key: string; canonical: string };
type ArchiveDigest = { version: number | undefined; digest: string | undefined };
type ArchiveDigestMap = Map<string, ArchiveDigest[]>;

function assertInputBounds(input: BrowserArchiveReconciliationInput): void {
  const parsedDay = new Date(`${input.day}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
    Number.isNaN(parsedDay.getTime()) ||
    parsedDay.toISOString().slice(0, 10) !== input.day
  )
    throw new Error('Invalid India calendar day');
  if (
    input.receipts.length > MAX_BROWSER_ARCHIVE_RECONCILIATION_FACTS ||
    input.archived.length > MAX_BROWSER_ARCHIVE_RECONCILIATION_FACTS
  )
    throw new Error('Browser archive reconciliation exceeds its work cap');
}

function collectReceipts(input: BrowserArchiveReconciliationInput): ReceiptMap {
  const receipts: ReceiptMap = new Map();
  for (const receipt of input.receipts) {
    const key = identity(receipt);
    if (receipts.has(key)) throw new Error('Duplicate D1 browser receipt');
    receipts.set(key, receipt);
  }
  return receipts;
}

function relevantArchiveFact(
  batch: BrowserArchiveFact,
  input: BrowserArchiveReconciliationInput,
  receipts: ReceiptMap,
): { key: string; relevant: boolean } {
  if (batch.workspace !== input.workspace) throw new Error('Archive workspace mismatch');
  if (
    !Array.isArray(batch.events) ||
    batch.events.length < 1 ||
    batch.events.length > MAX_BROWSER_ARCHIVE_BATCH_EVENTS
  )
    throw new Error('Archive fact exceeds the 25-event batch limit');
  const key = identity(batch);
  return {
    key,
    relevant:
      receipts.has(key) ||
      batch.events.some((event) => indiaDayForTimestamp(event.timestamp) === input.day),
  };
}

function collectArchiveCandidates(
  input: BrowserArchiveReconciliationInput,
  receipts: ReceiptMap,
): ArchiveCandidate[] {
  let serializedBytes = 0;
  const candidates: ArchiveCandidate[] = [];
  for (const batch of input.archived) {
    const { key, relevant } = relevantArchiveFact(batch, input, receipts);
    if (!relevant) continue;
    if (batchStringCodeUnits(batch) > MAX_BROWSER_ARCHIVE_BATCH_BYTES)
      throw new Error('Archive fact exceeds the pre-serialization string limit');
    const canonical = serializeBrowserEventFacts(batch);
    const bytes = new TextEncoder().encode(canonical).byteLength;
    if (bytes > MAX_BROWSER_ARCHIVE_BATCH_BYTES)
      throw new Error('Archive fact exceeds the 64 KiB serialized batch limit');
    serializedBytes += bytes;
    if (serializedBytes > MAX_BROWSER_ARCHIVE_RECONCILIATION_BYTES)
      throw new Error('Browser archive reconciliation exceeds the 8 MiB serialized-byte cap');
    candidates.push({ batch, key, canonical });
  }
  return candidates;
}

async function digestArchiveCandidates(candidates: ArchiveCandidate[]): Promise<ArchiveDigestMap> {
  const archived: ArchiveDigestMap = new Map();
  for (const { batch, key, canonical } of candidates) {
    const digest = await digestSerializedBrowserEventFacts(canonical);
    const validDigest = batch.facts_digest === undefined || digestPattern.test(batch.facts_digest);
    const facts = archived.get(key) ?? [];
    facts.push({
      version: validDigest && batch.facts_digest === digest ? batch.facts_digest_version : -1,
      digest: validDigest ? batch.facts_digest : undefined,
    });
    archived.set(key, facts);
  }
  return archived;
}

function receiptState(
  receipt: BrowserArchiveReconciliationInput['receipts'][number],
  candidates: ArchiveDigest[] = [],
): BrowserArchiveReconciliationState {
  if (receipt.facts_digest_version === null || receipt.facts_digest === null)
    return 'legacy_receipt';
  if (!digestPattern.test(receipt.facts_digest)) return 'digest_mismatch';
  if (candidates.length === 0) return 'missing_archive_fact';
  if (candidates.length > 1) return 'duplicate_archive_fact';
  const candidate = candidates[0];
  if (candidate?.version === undefined || candidate.digest === undefined)
    return 'archive_digest_missing';
  return candidate.version === BROWSER_EVENT_FACTS_DIGEST_VERSION &&
    receipt.facts_digest_version === BROWSER_EVENT_FACTS_DIGEST_VERSION &&
    candidate.digest === receipt.facts_digest
    ? 'matched'
    : 'digest_mismatch';
}

function reconciliationRows(receipts: ReceiptMap, archived: ArchiveDigestMap) {
  const rows: BrowserArchiveReconciliationRow[] = [];
  for (const [key, receipt] of receipts)
    rows.push({
      app_id: receipt.app_id,
      environment_id: receipt.environment_id,
      batch_id: receipt.batch_id,
      state: receiptState(receipt, archived.get(key)),
    });
  for (const [key, facts] of archived) {
    if (receipts.has(key)) continue;
    const [app_id, environment_id, batch_id] = JSON.parse(key) as [string, string, string];
    rows.push({ app_id, environment_id, batch_id, state: 'archive_without_d1_receipt' });
    if (facts.length > 1)
      rows.push({ app_id, environment_id, batch_id, state: 'duplicate_archive_fact' });
  }
  return rows.sort(
    (a, b) =>
      a.app_id.localeCompare(b.app_id) ||
      a.environment_id.localeCompare(b.environment_id) ||
      a.batch_id.localeCompare(b.batch_id) ||
      a.state.localeCompare(b.state),
  );
}

function incompleteReasons(
  input: BrowserArchiveReconciliationInput,
  rows: BrowserArchiveReconciliationRow[],
): string[] {
  const reasons = new Set<string>(
    rows.filter((row) => row.state !== 'matched').map((row) => row.state),
  );
  if (!input.receipt_pages_complete) reasons.add('receipt_pages_incomplete');
  if (!input.archive_lookup_complete) reasons.add('archive_lookup_incomplete');
  for (const [source, status] of [
    ['d1', input.d1_retention],
    ['r2', input.r2_retention],
  ] as const)
    if (status !== 'available') reasons.add(`${source}_retention_${status}`);
  for (const [source, status] of [
    ['queue', input.queue],
    ['dlq', input.dlq],
  ] as const)
    if (status !== 'reconciled') reasons.add(`${source}_${status}`);
  return [...reasons].sort();
}

/**
 * Compare one India event day of D1 receipts to already-read, manifest-verified archive rows.
 * This reports evidence only; it never advances coverage metadata or treats absent proof as zero.
 */
export async function reconcileBrowserArchiveDay(
  input: BrowserArchiveReconciliationInput,
): Promise<BrowserArchiveReconciliation> {
  assertInputBounds(input);
  const receipts = collectReceipts(input);
  const candidates = collectArchiveCandidates(input, receipts);
  const archived = await digestArchiveCandidates(candidates);
  const rows = reconciliationRows(receipts, archived);
  const incomplete_reasons = incompleteReasons(input, rows);
  return {
    day: input.day,
    complete: incomplete_reasons.length === 0,
    rows,
    incomplete_reasons,
  };
}
