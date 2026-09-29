import type { CollectedBrowserBatch } from './browser-analytics.js';
import {
  BROWSER_EVENT_FACTS_DIGEST_VERSION,
  digestBrowserEventFacts,
} from './browser-facts-digest.js';
import { indiaDayForTimestamp } from './browser-visitor-daily.js';

/** A parsed immutable R2 row. The caller must verify its segment manifest and bytes first. */
export type BrowserArchiveFact = Pick<
  CollectedBrowserBatch,
  'workspace' | 'app_id' | 'environment_id' | 'batch_id' | 'events' | 'visitor_hash'
> & { facts_digest_version?: number; facts_digest?: string };

export type BrowserArchiveReconciliationState =
  | 'matched'
  | 'missing_archive_fact'
  | 'legacy_receipt'
  | 'archive_digest_missing'
  | 'digest_mismatch'
  | 'duplicate_archive_fact'
  | 'archive_without_d1_receipt';

export type BrowserArchiveReconciliationRow = {
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

/** This cap bounds the in-memory join after the caller pages D1 and R2 independently. */
export const MAX_BROWSER_ARCHIVE_RECONCILIATION_FACTS = 10_000;

const identity = (fact: { app_id: string; environment_id: string; batch_id: string }) =>
  JSON.stringify([fact.app_id, fact.environment_id, fact.batch_id]);
const digestPattern = /^[a-f0-9]{64}$/;

/**
 * Compare one India event day of D1 receipts to already-read, manifest-verified archive rows.
 * This reports evidence only; it never advances coverage metadata or treats absent proof as zero.
 */
export async function reconcileBrowserArchiveDay(
  input: BrowserArchiveReconciliationInput,
): Promise<BrowserArchiveReconciliation> {
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

  const receipts = new Map<string, BrowserArchiveReconciliationInput['receipts'][number]>();
  for (const receipt of input.receipts) {
    const key = identity(receipt);
    if (receipts.has(key)) throw new Error('Duplicate D1 browser receipt');
    receipts.set(key, receipt);
  }

  const archived = new Map<
    string,
    Array<{ version: number | undefined; digest: string | undefined }>
  >();
  for (const batch of input.archived) {
    if (batch.workspace !== input.workspace) throw new Error('Archive workspace mismatch');
    const key = identity(batch);
    const isReceiptCandidate = receipts.has(key);
    if (
      !isReceiptCandidate &&
      !batch.events.some((event) => indiaDayForTimestamp(event.timestamp) === input.day)
    )
      continue;
    const facts = await digestBrowserEventFacts(batch);
    const storedDigestIsValid =
      batch.facts_digest === undefined || digestPattern.test(batch.facts_digest);
    const record = archived.get(key) ?? [];
    record.push({
      version:
        storedDigestIsValid && batch.facts_digest === facts ? batch.facts_digest_version : -1,
      digest: storedDigestIsValid ? batch.facts_digest : undefined,
    });
    archived.set(key, record);
  }

  const rows: BrowserArchiveReconciliationRow[] = [];
  const reasons = new Set<string>();
  for (const receipt of receipts.values()) {
    const key = identity(receipt);
    const candidates = archived.get(key) ?? [];
    let state: BrowserArchiveReconciliationState;
    if (receipt.facts_digest_version === null || receipt.facts_digest === null) {
      state = 'legacy_receipt';
    } else if (!digestPattern.test(receipt.facts_digest)) {
      state = 'digest_mismatch';
    } else if (candidates.length === 0) {
      state = 'missing_archive_fact';
    } else if (candidates.length > 1) {
      state = 'duplicate_archive_fact';
    } else if (candidates[0]?.version === undefined || candidates[0]?.digest === undefined) {
      state = 'archive_digest_missing';
    } else if (
      candidates[0].version !== BROWSER_EVENT_FACTS_DIGEST_VERSION ||
      receipt.facts_digest_version !== BROWSER_EVENT_FACTS_DIGEST_VERSION ||
      candidates[0].digest !== receipt.facts_digest
    ) {
      state = 'digest_mismatch';
    } else {
      state = 'matched';
    }
    if (state !== 'matched') reasons.add(state);
    rows.push({ ...receipt, state });
  }
  for (const [key, candidates] of archived) {
    if (receipts.has(key)) continue;
    const [app_id, environment_id, batch_id] = JSON.parse(key) as [string, string, string];
    rows.push({ app_id, environment_id, batch_id, state: 'archive_without_d1_receipt' });
    reasons.add('archive_without_d1_receipt');
    if (candidates.length > 1) reasons.add('duplicate_archive_fact');
  }

  if (!input.receipt_pages_complete) reasons.add('receipt_pages_incomplete');
  if (!input.archive_lookup_complete) reasons.add('archive_lookup_incomplete');
  for (const [source, status] of [
    ['d1', input.d1_retention],
    ['r2', input.r2_retention],
  ] as const) {
    if (status !== 'available') reasons.add(`${source}_retention_${status}`);
  }
  for (const [source, status] of [
    ['queue', input.queue],
    ['dlq', input.dlq],
  ] as const) {
    if (status !== 'reconciled') reasons.add(`${source}_${status}`);
  }

  rows.sort(
    (a, b) =>
      a.app_id.localeCompare(b.app_id) ||
      a.environment_id.localeCompare(b.environment_id) ||
      a.batch_id.localeCompare(b.batch_id),
  );
  const incomplete_reasons = [...reasons].sort();
  return {
    day: input.day,
    complete: incomplete_reasons.length === 0,
    rows,
    incomplete_reasons,
  };
}
