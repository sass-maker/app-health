import type { CollectedBrowserBatch } from './browser-analytics.js';
import { digestBrowserEventFacts } from './browser-facts-digest.js';
import { browserArchiveShard } from './browser-queue.js';
import {
  readBrowserArchiveAuditSegment,
  type SegmentReference,
} from './browser-archive-day-audit.js';
import { indiaDayForTimestamp } from './browser-visitor-daily.js';
import type { D1DatabaseLike } from './d1-adapter.js';

const SHARD_COUNT = 16;
const RECEIPTS_PER_SLICE = 30;
const SHARD_PAGE_SIZE = 3;
const SHARDS_PER_SLICE = 4;
const MAX_FACTS_PER_SLICE = 39;
const MAX_FACT_ROWS = 10_000;
const MAX_SEGMENTS = 5_000;
const MAX_ARCHIVE_FACTS = 10_000;
const MAX_JOBS_PER_WORKSPACE = 2;
const ACTIVE_JOB_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const SLICE_LEASE_MS = 5 * 60 * 1000;
const REASONS_ALWAYS_INCOMPLETE = [
  'batch_index_returns_one_candidate',
  'd1_retention_unverified',
  'dlq_evidence_unavailable',
  'queue_evidence_unavailable',
  'r2_retention_unverified',
  'snapshot_is_not_current_state_barrier',
];

type DayCursor = { event_day: string; object_key: string; snapshot_sequence: number };
type ShardState = {
  snapshot_sequence: number | null;
  cursor: DayCursor | null;
  exhausted: boolean;
};
type JobRow = {
  job_id: string;
  workspace_id: string;
  india_day: string;
  identity_salt: string;
  status: 'queued' | 'running' | 'finished' | 'incomplete';
  phase: 'receipts' | 'archive_index' | 'finalize' | 'done';
  created_at: number;
  updated_at: number;
  expires_at: number;
  lease_token: string | null;
  lease_until: number | null;
  receipt_high_water: number;
  expected_receipts: number;
  receipt_cursor: number;
  receipts_processed: number;
  slice_failures: number;
  shard_state_json: string;
  segment_count: number;
  archive_fact_count: number;
  incomplete_reasons_json: string;
};
type ReceiptRow = {
  row_id: number;
  app_id: string;
  environment_id: string;
  batch_id: string;
  facts_digest_version: number | null;
  facts_digest: string | null;
};
type AuditArchive = {
  getByName(name: string): {
    archiveSegmentsForEventDay(
      day: string,
      cursor: DayCursor | null,
      limit: number,
    ): Promise<{
      segments: SegmentReference[];
      next_cursor: DayCursor | null;
      snapshot_sequence: number;
    }>;
    archiveSegmentForBatch(
      appId: string,
      environmentId: string,
      batchId: string,
    ): Promise<SegmentReference | null>;
  };
};
export type BrowserArchiveAuditJobBindings = {
  db: D1DatabaseLike;
  archive: AuditArchive;
  history: Pick<R2Bucket, 'get'>;
};

const emptyShards = (): ShardState[] =>
  Array.from({ length: SHARD_COUNT }, () => ({
    snapshot_sequence: null,
    cursor: null,
    exhausted: false,
  }));

function safeDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function isHex(value: unknown, size: number): value is string {
  return typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
}

async function hashIdentity(salt: string, values: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${JSON.stringify(values)}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jobPublicState(row: JobRow, counts: AuditCounts) {
  const reasons = new Set<string>([
    ...REASONS_ALWAYS_INCOMPLETE,
    ...JSON.parse(row.incomplete_reasons_json),
  ]);
  if (row.status === 'finished') reasons.add('archive_day_index_snapshot_only');
  return {
    job_id: row.job_id,
    day: row.india_day,
    status: row.status,
    phase: row.phase,
    complete: false as const,
    progress: {
      expected_receipts: row.expected_receipts,
      receipts_processed: row.receipts_processed,
      segments_checked: row.segment_count,
      archive_facts_checked: row.archive_fact_count,
    },
    observed_comparison_counts: counts,
    incomplete_reasons: [...reasons].sort(),
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
  };
}

type AuditCounts = {
  matched: number;
  mismatched: number;
  no_archive_candidate: number;
  legacy_receipts: number;
  archive_only_facts: number;
  duplicate_archive_candidates: number;
  missing_archive_digests: number;
};

class AuditLeaseError extends Error {
  constructor(
    message: string,
    readonly leaseToken: string,
  ) {
    super(message);
  }
}

const zeroCounts = (): AuditCounts => ({
  matched: 0,
  mismatched: 0,
  no_archive_candidate: 0,
  legacy_receipts: 0,
  archive_only_facts: 0,
  duplicate_archive_candidates: 0,
  missing_archive_digests: 0,
});

async function countsForJob(db: D1DatabaseLike, jobId: string): Promise<AuditCounts> {
  const result = await db
    .prepare(
      `SELECT identity_hash, has_receipt, receipt_digest_version, receipt_digest,
              archive_count, archive_digest_version, archive_digest, archive_in_day
       FROM browser_archive_audit_facts WHERE job_id = ? LIMIT ?`,
    )
    .bind(jobId, MAX_FACT_ROWS + 1)
    .all<{
      identity_hash: string;
      has_receipt: number;
      receipt_digest_version: number | null;
      receipt_digest: string | null;
      archive_count: number;
      archive_in_day: number;
      archive_digest_version: number | null;
      archive_digest: string | null;
    }>();
  if (result.results.length > MAX_FACT_ROWS) throw new Error('audit fact row cap');
  const counts = zeroCounts();
  for (const row of result.results) {
    if (!row.has_receipt) {
      if (row.archive_count > 0 && row.archive_in_day) counts.archive_only_facts++;
      if (row.archive_count > 1) counts.duplicate_archive_candidates += row.archive_count - 1;
      continue;
    }
    if (row.receipt_digest_version === null || row.receipt_digest === null) {
      counts.legacy_receipts++;
      continue;
    }
    if (row.archive_count === 0) {
      counts.no_archive_candidate++;
      continue;
    }
    if (row.archive_count > 1) {
      counts.duplicate_archive_candidates += row.archive_count - 1;
      continue;
    }
    if (row.archive_digest_version === null || row.archive_digest === null) {
      counts.missing_archive_digests++;
      continue;
    }
    if (
      row.receipt_digest_version === 1 &&
      row.archive_digest_version === 1 &&
      isHex(row.receipt_digest, 64) &&
      isHex(row.archive_digest, 64) &&
      row.receipt_digest === row.archive_digest
    )
      counts.matched++;
    else counts.mismatched++;
  }
  return counts;
}

export async function startBrowserArchiveAuditJob(
  db: D1DatabaseLike,
  workspace: string,
  day: string,
  now = Date.now(),
) {
  if (!workspace || workspace.length > 200 || !safeDay(day)) throw new Error('invalid scope');
  await db
    .prepare(
      `UPDATE browser_archive_audit_jobs SET status = 'incomplete', phase = 'done',
       incomplete_reasons_json = '["audit_job_expired"]', lease_token = NULL,
       lease_until = NULL, updated_at = ?
       WHERE workspace_id = ? AND status IN ('queued', 'running') AND expires_at <= ?`,
    )
    .bind(now, workspace, now)
    .run();
  // The workspace/day uniqueness key outlives the public TTL. Retire an
  // expired same-day job (and its bounded pseudonymous children) before
  // attempting a fresh snapshot, so an operator can restart without waiting
  // for the hourly global cleanup pass.
  const expiredSameDay = await db
    .prepare(
      'SELECT job_id FROM browser_archive_audit_jobs WHERE workspace_id = ? AND india_day = ? AND expires_at <= ?',
    )
    .bind(workspace, day, now)
    .first<{ job_id: string }>();
  if (expiredSameDay) {
    await db.batch([
      db
        .prepare('DELETE FROM browser_archive_audit_facts WHERE job_id = ?')
        .bind(expiredSameDay.job_id),
      db
        .prepare('DELETE FROM browser_archive_audit_segments WHERE job_id = ?')
        .bind(expiredSameDay.job_id),
      db
        .prepare('DELETE FROM browser_archive_audit_jobs WHERE job_id = ? AND expires_at <= ?')
        .bind(expiredSameDay.job_id, now),
    ]);
  }
  const existing = await db
    .prepare(
      'SELECT * FROM browser_archive_audit_jobs WHERE workspace_id = ? AND india_day = ? AND expires_at > ?',
    )
    .bind(workspace, day, now)
    .first<JobRow>();
  if (existing) return jobPublicState(existing, await countsForJob(db, existing.job_id));
  const active = await db
    .prepare(
      "SELECT job_id FROM browser_archive_audit_jobs WHERE workspace_id = ? AND status IN ('queued', 'running') AND expires_at > ? LIMIT 1",
    )
    .bind(workspace, now)
    .first();
  if (active) throw new Error('audit already running');
  const jobsCount = await db
    .prepare(
      'SELECT COUNT(*) AS count FROM browser_archive_audit_jobs WHERE workspace_id = ? AND expires_at > ?',
    )
    .bind(workspace, now)
    .first<{ count: number }>();
  if ((jobsCount?.count ?? 0) >= MAX_JOBS_PER_WORKSPACE) throw new Error('audit job quota');
  const highWater = await db
    .prepare(
      `SELECT COALESCE(MAX(receipt.rowid), 0) AS high_water, COUNT(*) AS receipt_count
       FROM browser_visitor_receipt_days day_receipt
       JOIN browser_visitor_batch_receipts receipt
         ON receipt.workspace_id = day_receipt.workspace_id
        AND receipt.app_id = day_receipt.app_id
        AND receipt.environment_id = day_receipt.environment_id
        AND receipt.batch_id = day_receipt.batch_id
       WHERE day_receipt.workspace_id = ? AND day_receipt.india_day = ?`,
    )
    .bind(workspace, day)
    .first<{ high_water: number; receipt_count: number }>();
  if (!highWater) throw new Error('audit source unavailable');
  if (highWater.receipt_count > MAX_FACT_ROWS) throw new Error('audit receipt cap');
  const jobId = crypto.randomUUID();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const saltHex = [...salt].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO browser_archive_audit_jobs
       (job_id, workspace_id, india_day, identity_salt, status, phase, created_at,
        updated_at, expires_at, receipt_high_water, expected_receipts, shard_state_json)
       VALUES (?, ?, ?, ?, 'queued', 'receipts', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      jobId,
      workspace,
      day,
      saltHex,
      now,
      now,
      now + ACTIVE_JOB_TTL_MS,
      highWater.high_water,
      highWater.receipt_count,
      JSON.stringify(emptyShards()),
    )
    .run();
  if (!inserted.success) throw new Error('audit could not be queued');
  const row = await db
    .prepare(
      'SELECT * FROM browser_archive_audit_jobs WHERE workspace_id = ? AND india_day = ? AND expires_at > ?',
    )
    .bind(workspace, day, now)
    .first<JobRow>();
  if (!row) throw new Error('audit could not be queued');
  return jobPublicState(row, zeroCounts());
}

export async function readBrowserArchiveAuditJob(
  db: D1DatabaseLike,
  workspace: string,
  jobId: string,
  now = Date.now(),
) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const row = await db
    .prepare(
      'SELECT * FROM browser_archive_audit_jobs WHERE workspace_id = ? AND job_id = ? AND expires_at > ?',
    )
    .bind(workspace, jobId, now)
    .first<JobRow>();
  return row ? jobPublicState(row, await countsForJob(db, row.job_id)) : null;
}

function receiptQuery(
  db: D1DatabaseLike,
  jobId: string,
  row: ReceiptRow,
  identityHash: string,
  leaseToken: string,
) {
  return db
    .prepare(
      `INSERT INTO browser_archive_audit_facts
       (job_id, identity_hash, has_receipt, receipt_digest_version, receipt_digest)
       SELECT ?, ?, 1, ?, ? WHERE EXISTS (
         SELECT 1 FROM browser_archive_audit_jobs WHERE job_id = ? AND lease_token = ?
       )
       ON CONFLICT(job_id, identity_hash) DO UPDATE SET
         has_receipt = 1, receipt_digest_version = excluded.receipt_digest_version,
         receipt_digest = excluded.receipt_digest`,
    )
    .bind(jobId, identityHash, row.facts_digest_version, row.facts_digest, jobId, leaseToken);
}

function appendReason(reasons: string[], reason: string): string[] {
  return [...new Set([...reasons, reason])].sort();
}

async function markIncomplete(
  db: D1DatabaseLike,
  job: JobRow,
  reason: string,
  now: number,
  leaseToken: string,
) {
  const reasons = appendReason(JSON.parse(job.incomplete_reasons_json), reason);
  await db
    .prepare(
      `UPDATE browser_archive_audit_jobs SET status = 'incomplete', phase = 'done',
       updated_at = ?, expires_at = ?, incomplete_reasons_json = ?,
       lease_token = NULL, lease_until = NULL
       WHERE job_id = ? AND workspace_id = ? AND lease_token = ?`,
    )
    .bind(
      now,
      now + FINISHED_JOB_TTL_MS,
      JSON.stringify(reasons),
      job.job_id,
      job.workspace_id,
      leaseToken,
    )
    .run();
}

async function getJob(db: D1DatabaseLike, workspace: string, jobId: string) {
  return db
    .prepare('SELECT * FROM browser_archive_audit_jobs WHERE workspace_id = ? AND job_id = ?')
    .bind(workspace, jobId)
    .first<JobRow>();
}

async function countFactRows(db: D1DatabaseLike, jobId: string): Promise<number> {
  const count = await db
    .prepare('SELECT COUNT(*) AS count FROM browser_archive_audit_facts WHERE job_id = ?')
    .bind(jobId)
    .first<{ count: number }>();
  return count?.count ?? 0;
}

async function readReceiptSlice(db: D1DatabaseLike, job: JobRow): Promise<ReceiptRow[]> {
  const page = await db
    .prepare(
      `SELECT receipt.rowid AS row_id, receipt.app_id, receipt.environment_id,
              receipt.batch_id, receipt.facts_digest_version, receipt.facts_digest
       FROM browser_visitor_receipt_days day_receipt
       JOIN browser_visitor_batch_receipts receipt
         ON receipt.workspace_id = day_receipt.workspace_id
        AND receipt.app_id = day_receipt.app_id
        AND receipt.environment_id = day_receipt.environment_id
        AND receipt.batch_id = day_receipt.batch_id
       WHERE day_receipt.workspace_id = ? AND day_receipt.india_day = ?
         AND receipt.rowid > ? AND receipt.rowid <= ?
       ORDER BY receipt.rowid LIMIT ?`,
    )
    .bind(
      job.workspace_id,
      job.india_day,
      job.receipt_cursor,
      job.receipt_high_water,
      RECEIPTS_PER_SLICE + 1,
    )
    .all<ReceiptRow>();
  return page.results;
}

async function existingSegmentHashes(
  db: D1DatabaseLike,
  jobId: string,
  salt: string,
  refs: readonly SegmentReference[],
) {
  const hashes = await Promise.all(
    refs.map((ref) => hashIdentity(salt, ['segment', ref.object_key])),
  );
  if (!hashes.length) return new Set<string>();
  const rows = await db.batch(
    hashes.map((hash) =>
      db
        .prepare(
          'SELECT segment_hash FROM browser_archive_audit_segments WHERE job_id = ? AND segment_hash = ?',
        )
        .bind(jobId, hash),
    ),
  );
  return new Set(
    rows.flatMap((row) => (row.results?.length ? [String(row.results[0]?.segment_hash)] : [])),
  );
}

async function archiveWritesForSegments(
  db: D1DatabaseLike,
  job: JobRow,
  refs: readonly SegmentReference[],
  receiptHashes: ReadonlySet<string>,
  bindings: BrowserArchiveAuditJobBindings,
  includeAllFacts: boolean,
  leaseToken: string,
) {
  const uniqueRefs = [...new Map(refs.map((ref) => [ref.object_key, ref])).values()];
  const seen = await existingSegmentHashes(db, job.job_id, job.identity_salt, uniqueRefs);
  const freshWithHashes: Array<{ ref: SegmentReference; hash: string }> = [];
  for (const ref of uniqueRefs) {
    const hash = await hashIdentity(job.identity_salt, ['segment', ref.object_key]);
    if (!seen.has(hash)) freshWithHashes.push({ ref, hash });
  }
  if (freshWithHashes.length + job.segment_count > MAX_SEGMENTS)
    throw new Error('audit segment cap');
  const byteState = { compressed: 0, decompressed: 0 };
  const input = {
    db,
    workspace: job.workspace_id,
    day: job.india_day,
    archive: bindings.archive,
    history: bindings.history,
  };
  const factRows: Array<{
    identity_hash: string;
    digest_version?: number;
    digest?: string;
    target_day: boolean;
  }> = [];
  const pendingFacts: Array<{
    batch: CollectedBrowserBatch;
    identity_hash: string;
    target_day: boolean;
  }> = [];
  const processedSegments: string[] = [];
  for (const { ref, hash } of freshWithHashes) {
    const batches = await readBrowserArchiveAuditSegment(input, ref, byteState);
    processedSegments.push(hash);
    for (const batch of batches) {
      if (pendingFacts.length >= MAX_FACTS_PER_SLICE * 2) throw new Error('audit fact slice cap');
      if (batch.workspace !== job.workspace_id) throw new Error('archive workspace mismatch');
      const identityHash = await hashIdentity(job.identity_salt, [
        batch.app_id,
        batch.environment_id,
        batch.batch_id,
      ]);
      const isTargetDay = batch.events.some(
        (event) => indiaDayForTimestamp(event.timestamp) === job.india_day,
      );
      pendingFacts.push({ batch, identity_hash: identityHash, target_day: isTargetDay });
    }
  }
  const outsideDay = pendingFacts.filter(
    (fact) => !includeAllFacts && !fact.target_day && !receiptHashes.has(fact.identity_hash),
  );
  const knownReceipts = new Set<string>();
  if (outsideDay.length) {
    const knownRows = await db.batch(
      outsideDay.map((fact) =>
        db
          .prepare(
            'SELECT identity_hash FROM browser_archive_audit_facts WHERE job_id = ? AND identity_hash = ? AND has_receipt = 1',
          )
          .bind(job.job_id, fact.identity_hash),
      ),
    );
    for (const result of knownRows)
      if (result.results?.[0]) knownReceipts.add(String(result.results[0].identity_hash));
  }
  const relevantFacts = pendingFacts.filter(
    (fact) =>
      includeAllFacts ||
      fact.target_day ||
      receiptHashes.has(fact.identity_hash) ||
      knownReceipts.has(fact.identity_hash),
  );
  if (relevantFacts.length > MAX_FACTS_PER_SLICE) throw new Error('audit fact slice cap');
  for (const { batch, identity_hash } of relevantFacts) {
    const computedDigest = await digestBrowserEventFacts(batch);
    const digestMatches =
      typeof batch.facts_digest === 'string' && batch.facts_digest === computedDigest;
    factRows.push({
      identity_hash,
      digest_version:
        typeof batch.facts_digest_version === 'number'
          ? digestMatches
            ? batch.facts_digest_version
            : -1
          : undefined,
      digest: typeof batch.facts_digest === 'string' ? batch.facts_digest : undefined,
      target_day: pendingFacts.some(
        (fact) => fact.identity_hash === identity_hash && fact.target_day,
      ),
    });
  }
  const existing = await countFactRows(db, job.job_id);
  const uniqueKeys = new Set(factRows.map((row) => row.identity_hash));
  if (existing + uniqueKeys.size > MAX_FACT_ROWS) throw new Error('audit fact row cap');
  if (job.archive_fact_count + factRows.length > MAX_ARCHIVE_FACTS)
    throw new Error('audit archive fact cap');
  const writes = [
    ...processedSegments.map((hash) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO browser_archive_audit_segments (job_id, segment_hash)
           SELECT ?, ? WHERE EXISTS (
             SELECT 1 FROM browser_archive_audit_jobs WHERE job_id = ? AND lease_token = ?
           )`,
        )
        .bind(job.job_id, hash, job.job_id, leaseToken),
    ),
    ...factRows.map((row) =>
      db
        .prepare(
          `INSERT INTO browser_archive_audit_facts
           (job_id, identity_hash, archive_count, archive_digest_version, archive_digest, archive_in_day)
           SELECT ?, ?, 1, ?, ?, ? WHERE EXISTS (
             SELECT 1 FROM browser_archive_audit_jobs WHERE job_id = ? AND lease_token = ?
           )
           ON CONFLICT(job_id, identity_hash) DO UPDATE SET
             archive_count = browser_archive_audit_facts.archive_count + 1,
             archive_in_day = MAX(browser_archive_audit_facts.archive_in_day, excluded.archive_in_day),
             archive_digest_version = CASE WHEN browser_archive_audit_facts.archive_count = 0
               THEN excluded.archive_digest_version ELSE browser_archive_audit_facts.archive_digest_version END,
             archive_digest = CASE WHEN browser_archive_audit_facts.archive_count = 0
               THEN excluded.archive_digest ELSE browser_archive_audit_facts.archive_digest END`,
        )
        .bind(
          job.job_id,
          row.identity_hash,
          row.digest_version ?? null,
          row.digest ?? null,
          row.target_day ? 1 : 0,
          job.job_id,
          leaseToken,
        ),
    ),
  ];
  return { segments: processedSegments.length, facts: factRows.length, writes };
}

async function processReceiptSlice(
  db: D1DatabaseLike,
  job: JobRow,
  bindings: BrowserArchiveAuditJobBindings,
  now: number,
  leaseToken: string,
) {
  if (job.expected_receipts > MAX_FACT_ROWS) throw new Error('audit receipt cap');
  const page = await readReceiptSlice(db, job);
  if (!page.length) {
    if (job.receipts_processed !== job.expected_receipts)
      throw new Error('receipt snapshot changed');
    await db
      .prepare(
        `UPDATE browser_archive_audit_jobs SET phase = 'archive_index', status = 'running',
         lease_token = NULL, lease_until = NULL, updated_at = ? WHERE job_id = ? AND lease_token = ?`,
      )
      .bind(now, job.job_id, leaseToken)
      .run();
    return;
  }
  const receipts = page.slice(0, RECEIPTS_PER_SLICE);
  const identityHashes = await Promise.all(
    receipts.map((row) =>
      hashIdentity(job.identity_salt, [row.app_id, row.environment_id, row.batch_id]),
    ),
  );
  const receiptHashSet = new Set(identityHashes);
  const refs: SegmentReference[] = [];
  for (const row of receipts) {
    const shard = await browserArchiveShard({
      workspace: job.workspace_id,
      app_id: row.app_id,
      environment_id: row.environment_id,
      batch_id: row.batch_id,
      received_at: now,
      events: [],
    } as CollectedBrowserBatch);
    const stub = bindings.archive.getByName(shard);
    const ref = await stub.archiveSegmentForBatch(row.app_id, row.environment_id, row.batch_id);
    if (ref) refs.push(ref);
  }
  const receiptWrites = receipts.map((row, index) =>
    receiptQuery(db, job.job_id, row, identityHashes[index]!, leaseToken),
  );
  const archive = await archiveWritesForSegments(
    db,
    job,
    refs,
    receiptHashSet,
    bindings,
    true,
    leaseToken,
  );
  if ((await countFactRows(db, job.job_id)) + receipts.length + archive.facts > MAX_FACT_ROWS)
    throw new Error('audit fact row cap');
  const nextCursor = receipts[receipts.length - 1]!.row_id;
  const finalWrites = [
    ...archive.writes,
    ...receiptWrites,
    db
      .prepare(
        `UPDATE browser_archive_audit_jobs SET status = 'running', phase = ?,
         receipt_cursor = ?, receipts_processed = receipts_processed + ?,
         segment_count = segment_count + ?, archive_fact_count = archive_fact_count + ?,
         lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE job_id = ? AND lease_token = ? AND receipt_cursor < ?`,
      )
      .bind(
        'receipts',
        nextCursor,
        receipts.length,
        archive.segments,
        archive.facts,
        now,
        job.job_id,
        leaseToken,
        nextCursor,
      ),
  ];
  const results = await db.batch(finalWrites);
  if (results.some((result) => !result.success)) throw new Error('audit receipt slice failed');
}

async function processArchiveIndexSlice(
  db: D1DatabaseLike,
  job: JobRow,
  bindings: BrowserArchiveAuditJobBindings,
  now: number,
  leaseToken: string,
) {
  const states = JSON.parse(job.shard_state_json) as ShardState[];
  if (states.length !== SHARD_COUNT) throw new Error('invalid shard cursor state');
  let processed = 0;
  let addedSegments = 0;
  let addedFacts = 0;
  const factWrites: Array<ReturnType<D1DatabaseLike['prepare']>> = [];
  for (let shard = 0; shard < SHARD_COUNT && processed < SHARDS_PER_SLICE; shard++) {
    const state = states[shard]!;
    if (state.exhausted) continue;
    const page = await bindings.archive
      .getByName(`${job.workspace_id}:browser-archive-v1:${shard}`)
      .archiveSegmentsForEventDay(job.india_day, state.cursor, SHARD_PAGE_SIZE);
    if (!Number.isSafeInteger(page.snapshot_sequence) || page.snapshot_sequence < 0)
      throw new Error('invalid archive index snapshot');
    if (state.snapshot_sequence !== null && state.snapshot_sequence !== page.snapshot_sequence)
      throw new Error('archive index snapshot changed');
    state.snapshot_sequence = page.snapshot_sequence;
    state.cursor = page.next_cursor;
    state.exhausted = page.next_cursor === null;
    const result = await archiveWritesForSegments(
      db,
      job,
      page.segments,
      new Set(),
      bindings,
      false,
      leaseToken,
    );
    if (addedFacts + result.facts > MAX_FACTS_PER_SLICE) throw new Error('audit fact slice cap');
    if ((await countFactRows(db, job.job_id)) + addedFacts + result.facts > MAX_FACT_ROWS)
      throw new Error('audit fact row cap');
    for (const statement of result.writes) {
      // A duplicate reference within the same bounded invocation is counted once.
      // Segment keys are salted hashes and appear only in this short-lived set.
      factWrites.push(statement);
    }
    addedSegments += result.segments;
    addedFacts += result.facts;
    processed++;
  }
  if (job.segment_count + addedSegments > MAX_SEGMENTS) throw new Error('audit segment cap');
  if (job.archive_fact_count + addedFacts > MAX_ARCHIVE_FACTS)
    throw new Error('audit archive fact cap');
  const phase = states.every((state) => state.exhausted) ? 'finalize' : 'archive_index';
  // Cursor advancement and the corresponding facts commit together in each page slice.
  const writes = [
    ...factWrites,
    db
      .prepare(
        `UPDATE browser_archive_audit_jobs SET status = 'running', phase = ?,
         shard_state_json = ?, segment_count = segment_count + ?,
       archive_fact_count = archive_fact_count + ?, lease_token = NULL,
       lease_until = NULL, updated_at = ? WHERE job_id = ? AND lease_token = ?`,
      )
      .bind(phase, JSON.stringify(states), addedSegments, addedFacts, now, job.job_id, leaseToken),
  ];
  const results = await db.batch(writes);
  if (results.some((result) => !result.success)) throw new Error('audit index slice failed');
}

async function finalizeAuditJob(db: D1DatabaseLike, job: JobRow, now: number, leaseToken: string) {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS receipts FROM browser_archive_audit_facts WHERE job_id = ? AND has_receipt = 1',
    )
    .bind(job.job_id)
    .first<{ receipts: number }>();
  const reasons = JSON.parse(job.incomplete_reasons_json) as string[];
  if ((row?.receipts ?? 0) !== job.expected_receipts)
    reasons.push('receipt_count_changed_during_audit');
  const update = await db
    .prepare(
      `UPDATE browser_archive_audit_jobs SET status = 'finished', phase = 'done',
       updated_at = ?, expires_at = ?, incomplete_reasons_json = ?,
       lease_token = NULL, lease_until = NULL WHERE job_id = ? AND lease_token = ?`,
    )
    .bind(
      now,
      now + FINISHED_JOB_TTL_MS,
      JSON.stringify(appendReason(reasons, 'audit_is_evidence_only')),
      job.job_id,
      leaseToken,
    )
    .run();
  if (!update.success) throw new Error('audit finalize failed');
}

/** Process one fixed-work slice. Repeating a slice is safe because writes and cursors commit together. */
export async function processBrowserArchiveAuditJob(
  bindings: BrowserArchiveAuditJobBindings,
  workspace: string,
  jobId: string,
  now = Date.now(),
) {
  const { db } = bindings;
  const job = await getJob(db, workspace, jobId);
  if (!job || job.expires_at <= now || ['finished', 'incomplete'].includes(job.status)) return;
  const leaseToken = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `UPDATE browser_archive_audit_jobs SET lease_token = ?, lease_until = ?
       WHERE job_id = ? AND workspace_id = ? AND expires_at > ?
         AND status IN ('queued', 'running')
         AND (lease_token IS NULL OR lease_until <= ?)`,
    )
    .bind(leaseToken, now + SLICE_LEASE_MS, jobId, workspace, now, now)
    .run();
  if ((claimed.meta.changes ?? 0) !== 1) return;
  const claimedJob = await getJob(db, workspace, jobId);
  if (!claimedJob || claimedJob.lease_token !== leaseToken) return;
  try {
    if (claimedJob.phase === 'receipts')
      await processReceiptSlice(db, claimedJob, bindings, now, leaseToken);
    else if (claimedJob.phase === 'archive_index')
      await processArchiveIndexSlice(db, claimedJob, bindings, now, leaseToken);
    else if (claimedJob.phase === 'finalize')
      await finalizeAuditJob(db, claimedJob, now, leaseToken);
  } catch (error) {
    throw new AuditLeaseError(
      error instanceof Error ? error.message : 'audit slice failed',
      leaseToken,
    );
  }
}

/** Scheduled driver: bounded job count and per-job slice count per hourly trigger. */
export async function processPendingBrowserArchiveAuditJobs(
  bindings: BrowserArchiveAuditJobBindings,
  now = Date.now(),
) {
  const expired = await bindings.db
    .prepare(
      `DELETE FROM browser_archive_audit_facts WHERE rowid IN
       (SELECT facts.rowid FROM browser_archive_audit_facts facts
        JOIN browser_archive_audit_jobs jobs ON jobs.job_id = facts.job_id
        WHERE jobs.expires_at <= ? LIMIT 10000)`,
    )
    .bind(now)
    .run();
  if (!expired.success) return;
  await bindings.db
    .prepare(
      `DELETE FROM browser_archive_audit_segments WHERE rowid IN
       (SELECT segments.rowid FROM browser_archive_audit_segments segments
        JOIN browser_archive_audit_jobs jobs ON jobs.job_id = segments.job_id
        WHERE jobs.expires_at <= ? LIMIT 10000)`,
    )
    .bind(now)
    .run();
  await bindings.db
    .prepare(
      `DELETE FROM browser_archive_audit_jobs WHERE rowid IN
       (SELECT jobs.rowid FROM browser_archive_audit_jobs jobs
        WHERE jobs.expires_at <= ?
          AND NOT EXISTS (SELECT 1 FROM browser_archive_audit_facts facts WHERE facts.job_id = jobs.job_id)
          AND NOT EXISTS (SELECT 1 FROM browser_archive_audit_segments segments WHERE segments.job_id = jobs.job_id)
        LIMIT 100)`,
    )
    .bind(now)
    .run();
  const jobs = await bindings.db
    .prepare(
      "SELECT job_id, workspace_id FROM browser_archive_audit_jobs WHERE status IN ('queued', 'running') AND expires_at > ? ORDER BY created_at LIMIT 1",
    )
    .bind(now)
    .all<{ job_id: string; workspace_id: string }>();
  const job = jobs.results[0];
  if (!job) return;
  for (let slice = 0; slice < 3; slice++) {
    const current = await getJob(bindings.db, job.workspace_id, job.job_id);
    if (!current || ['finished', 'incomplete'].includes(current.status)) break;
    try {
      await processBrowserArchiveAuditJob(bindings, job.workspace_id, job.job_id, now + slice);
    } catch (error) {
      const leaseToken = error instanceof AuditLeaseError ? error.leaseToken : null;
      if (!leaseToken) break;
      const message = error instanceof AuditLeaseError ? error.message : '';
      const terminalReason =
        message &&
        [
          'audit fact row cap',
          'audit segment cap',
          'audit receipt cap',
          'audit fact slice cap',
          'audit archive fact cap',
        ].includes(message)
          ? message.replaceAll(' ', '_')
          : message.includes('snapshot changed')
            ? 'archive_index_snapshot_changed'
            : message.includes('receipt snapshot')
              ? 'receipt_snapshot_changed'
              : null;
      if (terminalReason) {
        await markIncomplete(bindings.db, current, terminalReason, now + slice, leaseToken);
      } else if (current.slice_failures + 1 >= 3) {
        await markIncomplete(
          bindings.db,
          current,
          'audit_slice_retries_exhausted',
          now + slice,
          leaseToken,
        );
      } else {
        await bindings.db
          .prepare(
            `UPDATE browser_archive_audit_jobs SET slice_failures = slice_failures + 1,
             lease_token = NULL, lease_until = NULL, updated_at = ?
             WHERE job_id = ? AND lease_token = ?`,
          )
          .bind(now + slice, current.job_id, leaseToken)
          .run();
      }
      break;
    }
  }
}
