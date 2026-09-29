import type { CollectedBrowserBatch } from './browser-analytics.js';
import type { D1DatabaseLike } from './d1-adapter.js';
import {
  BROWSER_EVENT_FACTS_DIGEST_VERSION,
  digestBrowserEventFacts,
} from './browser-facts-digest.js';

const INDIA_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
const BROWSER_VISITOR_DAY_MS = 86_400_000;
const BROWSER_VISITOR_MAX_LATENESS_MS = BROWSER_VISITOR_DAY_MS;
export const BROWSER_VISITOR_MAX_FUTURE_SKEW_MS = 60_000;
/** Let requests that crossed the late-event boundary finish their D1 receipt commit. */
export const BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS = 60_000;
/** Provisional bounded retention; validate briefing lookback and D1 growth before release. */
export const BROWSER_VISITOR_RETENTION_DAYS = 35;
const BROWSER_VISITOR_RETENTION_MS = BROWSER_VISITOR_RETENTION_DAYS * BROWSER_VISITOR_DAY_MS;
const RECEIPT_RETENTION_MS = BROWSER_VISITOR_RETENTION_MS;
const VISITOR_HASH = /^[a-f0-9]{64}$/i;
const MAX_RETENTION_ROWS_PER_TABLE_PER_RUN = 10_000;
export const MAX_EXACT_BROWSER_VISITOR_SCOPES = 128;
export const MAX_BROWSER_VISITOR_RECEIPT_PAGE_SIZE = 500;
const MAX_BROWSER_VISITOR_RECEIPT_EVENTS = 25;

type ExactBrowserVisitorDay =
  { complete: true; visitors: number } | { complete: false; visitors: null };
export type ExactBrowserVisitorScope = { app_id: string; environment_id: string };
export type ExactBrowserVisitorResult = ExactBrowserVisitorScope & ExactBrowserVisitorDay;
export type BrowserVisitorRolloutProof = {
  workspace_id: string;
  generation_id: string;
  worker_version_id: string;
  source_sha: string;
  rollout_started_at: number;
  rollout_observed_at: number;
  rollout_traffic_percent: number;
};
export type BrowserVisitorCoverageAudit = {
  workspace_id: string;
  audit_id: string;
  audit_kind: 'worker_rollouts' | 'tracker_scope';
  app_id?: string;
  environment_id?: string;
  audited_through: number;
  observed_at: number;
  evidence_sha: string;
};
type BrowserVisitorReceiptScope = ExactBrowserVisitorScope & { batch_id: string };
export type BrowserVisitorReceiptCursor = BrowserVisitorReceiptScope;
export type BrowserVisitorReceiptPage = {
  receipts: Array<
    BrowserVisitorReceiptScope & {
      fingerprint: string;
      accepted_at: number | null;
      event_count: number | null;
      facts_digest_version: number | null;
      facts_digest: string | null;
    }
  >;
  next_cursor: BrowserVisitorReceiptCursor | null;
};

export function indiaDayForTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('Invalid browser event timestamp');
  return new Date(timestamp + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

function indiaDayBounds(day: string): { from: number; to: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  )
    return null;
  const from = parsed.getTime() - INDIA_OFFSET_MS;
  return { from, to: from + BROWSER_VISITOR_DAY_MS };
}

function validProofTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCoverageAuditScope(input: BrowserVisitorCoverageAudit): boolean {
  if (input.audit_kind === 'worker_rollouts') return !input.app_id && !input.environment_id;
  return input.audit_kind === 'tracker_scope' && !!input.app_id && !!input.environment_id;
}

function validCoverageAudit(input: BrowserVisitorCoverageAudit): boolean {
  return (
    !!input.workspace_id &&
    !!input.audit_id &&
    validCoverageAuditScope(input) &&
    validProofTimestamp(input.audited_through) &&
    validProofTimestamp(input.observed_at) &&
    input.observed_at >= input.audited_through &&
    /^[a-f0-9]{64}$/i.test(input.evidence_sha)
  );
}

function validateRolloutProof(proof: BrowserVisitorRolloutProof): void {
  if (
    !proof.workspace_id ||
    !proof.generation_id ||
    !proof.worker_version_id ||
    !/^[a-f0-9]{40}$/i.test(proof.source_sha) ||
    !validProofTimestamp(proof.rollout_started_at) ||
    !validProofTimestamp(proof.rollout_observed_at) ||
    proof.rollout_observed_at < proof.rollout_started_at ||
    !Number.isInteger(proof.rollout_traffic_percent) ||
    proof.rollout_traffic_percent < 0 ||
    proof.rollout_traffic_percent > 100
  )
    throw new Error('Invalid browser visitor rollout proof');
}

/** Record the provider-observed start of a Worker rollout; this invalidates prior proof after this time. */
export async function recordBrowserVisitorRolloutStart(
  db: D1DatabaseLike,
  proof: BrowserVisitorRolloutProof,
): Promise<void> {
  validateRolloutProof(proof);
  const result = await db
    .prepare(
      `INSERT INTO browser_visitor_acceptance_rollouts
         (workspace_id, generation_id, worker_version_id, source_sha,
          rollout_started_at, rollout_observed_at, rollout_traffic_percent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      proof.workspace_id,
      proof.generation_id,
      proof.worker_version_id,
      proof.source_sha.toLowerCase(),
      proof.rollout_started_at,
      proof.rollout_observed_at,
      proof.rollout_traffic_percent,
    )
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error('Browser visitor rollout start was not recorded');
}

/** Confirm exact 100% traffic only after the provider reports this version/SHA fully active. */
export async function confirmBrowserVisitorRolloutFullTraffic(
  db: D1DatabaseLike,
  input: {
    workspace_id: string;
    generation_id: string;
    worker_version_id: string;
    source_sha: string;
    full_traffic_at: number;
    observed_at: number;
    traffic_percent: number;
  },
): Promise<void> {
  if (
    !input.workspace_id ||
    !input.generation_id ||
    !input.worker_version_id ||
    !/^[a-f0-9]{40}$/i.test(input.source_sha) ||
    !validProofTimestamp(input.full_traffic_at) ||
    !validProofTimestamp(input.observed_at) ||
    input.observed_at < input.full_traffic_at ||
    input.traffic_percent !== 100
  )
    throw new Error('Browser visitor 100% rollout proof is invalid');
  const result = await db
    .prepare(
      `UPDATE browser_visitor_acceptance_rollouts
       SET full_traffic_at = ?, full_traffic_observed_at = ?, full_traffic_percent = 100
       WHERE workspace_id = ? AND generation_id = ? AND worker_version_id = ?
         AND source_sha = ? AND rollout_started_at <= ? AND full_traffic_percent IS NULL`,
    )
    .bind(
      input.full_traffic_at,
      input.observed_at,
      input.workspace_id,
      input.generation_id,
      input.worker_version_id,
      input.source_sha.toLowerCase(),
      input.full_traffic_at,
    )
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error('Browser visitor 100% rollout proof did not match its start record');
}

/** Record owner-verified production tracker activation for one app/environment scope. */
export async function recordBrowserVisitorScopeActivation(
  db: D1DatabaseLike,
  input: {
    workspace_id: string;
    app_id: string;
    environment_id: string;
    activated_at: number;
    verified_at: number;
    tracker_source_sha: string;
  },
): Promise<void> {
  if (
    !input.workspace_id ||
    !input.app_id ||
    !input.environment_id ||
    !validProofTimestamp(input.activated_at) ||
    !validProofTimestamp(input.verified_at) ||
    input.verified_at < input.activated_at ||
    !/^[a-f0-9]{40}$/i.test(input.tracker_source_sha)
  )
    throw new Error('Browser visitor scope activation proof is invalid');
  const environment = await db
    .prepare(
      `SELECT e.app_id, lower(e.name) AS name FROM environments e
       JOIN workspace_apps wa ON wa.app_id = e.app_id AND wa.workspace_id = ?
       WHERE e.id = ? AND e.app_id = ?`,
    )
    .bind(input.workspace_id, input.environment_id, input.app_id)
    .first<{ app_id: string; name: string }>();
  if (environment?.app_id !== input.app_id || environment.name !== 'production')
    throw new Error('Browser visitor activation must identify a production app environment');
  const result = await db
    .prepare(
      `INSERT INTO browser_visitor_scope_activations
         (workspace_id, app_id, environment_id, activated_at, verified_at, tracker_source_sha)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, app_id, environment_id, activated_at, tracker_source_sha)
       DO NOTHING`,
    )
    .bind(
      input.workspace_id,
      input.app_id,
      input.environment_id,
      input.activated_at,
      input.verified_at,
      input.tracker_source_sha.toLowerCase(),
    )
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error('Browser visitor scope activation was not recorded');
}

/** Close an attested tracker interval; days intersecting the interval end stay Unknown. */
export async function deactivateBrowserVisitorScope(
  db: D1DatabaseLike,
  input: {
    workspace_id: string;
    app_id: string;
    environment_id: string;
    activated_at: number;
    tracker_source_sha: string;
    deactivated_at: number;
  },
): Promise<void> {
  if (
    !input.workspace_id ||
    !input.app_id ||
    !input.environment_id ||
    !validProofTimestamp(input.activated_at) ||
    !validProofTimestamp(input.deactivated_at) ||
    input.deactivated_at < input.activated_at ||
    !/^[a-f0-9]{40}$/i.test(input.tracker_source_sha)
  )
    throw new Error('Browser visitor scope deactivation proof is invalid');
  const result = await db
    .prepare(
      `UPDATE browser_visitor_scope_activations SET deactivated_at = ?
       WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
         AND activated_at = ? AND tracker_source_sha = ? AND deactivated_at IS NULL`,
    )
    .bind(
      input.deactivated_at,
      input.workspace_id,
      input.app_id,
      input.environment_id,
      input.activated_at,
      input.tracker_source_sha.toLowerCase(),
    )
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error('Browser visitor scope activation was not open');
}

/** Record an owner-reviewed provider audit whose digest identifies its redacted evidence. */
export async function recordBrowserVisitorCoverageAudit(
  db: D1DatabaseLike,
  input: BrowserVisitorCoverageAudit,
): Promise<void> {
  if (!validCoverageAudit(input)) throw new Error('Invalid browser visitor coverage audit');
  const result = await db
    .prepare(
      `INSERT INTO browser_visitor_coverage_audits
         (workspace_id, audit_id, audit_kind, app_id, environment_id,
          audited_through, observed_at, evidence_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.workspace_id,
      input.audit_id,
      input.audit_kind,
      input.app_id ?? null,
      input.environment_id ?? null,
      input.audited_through,
      input.observed_at,
      input.evidence_sha.toLowerCase(),
    )
    .run();
  if (!result.success || result.meta.changes !== 1)
    throw new Error('Browser visitor coverage audit was not recorded');
}

/**
 * Atomically seal one India day after complete provider audits. Acceptance and
 * sealing serialize on the same D1 row; whichever commits first determines
 * whether the final late batch is included or rejected.
 */
const SEAL_EXACT_BROWSER_VISITOR_DAY_SQL = `WITH eligible AS (
         SELECT rollout.generation_id, activation.activated_at,
                activation.tracker_source_sha, worker_audit.audit_id AS worker_audit_id,
                scope_audit.audit_id AS scope_audit_id
         FROM browser_visitor_acceptance_rollouts rollout
         JOIN browser_visitor_coverage_audits worker_audit
           ON worker_audit.workspace_id = rollout.workspace_id
          AND worker_audit.audit_kind = 'worker_rollouts'
          AND worker_audit.audited_through >= ? AND worker_audit.observed_at <= ?
         JOIN browser_visitor_scope_activations activation
           ON activation.workspace_id = rollout.workspace_id
          AND activation.app_id = ? AND activation.environment_id = ?
         JOIN environments production_environment
           ON production_environment.id = activation.environment_id
          AND production_environment.app_id = activation.app_id
          AND lower(production_environment.name) = 'production'
         JOIN workspace_apps owned_app
           ON owned_app.workspace_id = activation.workspace_id
          AND owned_app.app_id = activation.app_id
         JOIN browser_visitor_coverage_audits scope_audit
           ON scope_audit.workspace_id = activation.workspace_id
          AND scope_audit.audit_kind = 'tracker_scope'
          AND scope_audit.app_id = activation.app_id
          AND scope_audit.environment_id = activation.environment_id
          AND scope_audit.audited_through >= ? AND scope_audit.observed_at <= ?
         WHERE rollout.workspace_id = ?
           AND rollout.full_traffic_percent = 100
           AND rollout.full_traffic_at <= ?
           AND rollout.full_traffic_observed_at <= ?
           AND activation.activated_at <= ?
           AND activation.verified_at <= ?
           AND (activation.deactivated_at IS NULL OR activation.deactivated_at >= ?)
           AND (SELECT COUNT(*) FROM browser_visitor_scope_activations overlapping
                WHERE overlapping.workspace_id = activation.workspace_id
                  AND overlapping.app_id = activation.app_id
                  AND overlapping.environment_id = activation.environment_id
                  AND overlapping.activated_at < ?
                  AND (overlapping.deactivated_at IS NULL OR overlapping.deactivated_at > ?)
               ) = 1
           AND NOT EXISTS (
             SELECT 1 FROM browser_visitor_acceptance_rollouts interrupted
             WHERE interrupted.workspace_id = rollout.workspace_id
               AND interrupted.generation_id != rollout.generation_id
               AND interrupted.rollout_started_at >= rollout.full_traffic_at
               AND interrupted.rollout_started_at <= ?
           )
         ORDER BY rollout.full_traffic_at DESC, rollout.generation_id DESC LIMIT 1
       )
       INSERT INTO browser_visitor_acceptance_day_fences
         (workspace_id, app_id, environment_id, india_day, state, sealed_at, expires_at,
          rollout_generation_id, tracker_activation_at, tracker_source_sha,
          worker_audit_id, scope_audit_id)
       SELECT ?, ?, ?, ?, 'sealed', ?, ?, eligible.generation_id, eligible.activated_at,
              eligible.tracker_source_sha, eligible.worker_audit_id, eligible.scope_audit_id
       FROM eligible WHERE 1
       ON CONFLICT (workspace_id, app_id, environment_id, india_day)
       DO UPDATE SET state = 'sealed', sealed_at = excluded.sealed_at, expires_at = excluded.expires_at,
         rollout_generation_id = excluded.rollout_generation_id,
         tracker_activation_at = excluded.tracker_activation_at,
         tracker_source_sha = excluded.tracker_source_sha,
         worker_audit_id = excluded.worker_audit_id,
         scope_audit_id = excluded.scope_audit_id
       WHERE browser_visitor_acceptance_day_fences.state = 'open'`;

export async function sealExactBrowserVisitorDay(
  db: D1DatabaseLike,
  input: {
    workspace_id: string;
    app_id: string;
    environment_id: string;
    day: string;
    now: number;
  },
): Promise<boolean> {
  const bounds = indiaDayBounds(input.day);
  if (!bounds) throw new Error('Invalid India calendar day');
  if (
    !input.workspace_id ||
    !input.app_id ||
    !input.environment_id ||
    !validProofTimestamp(input.now)
  )
    throw new Error('Invalid browser visitor day seal');
  const closeAt =
    bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
  if (input.now < closeAt) return false;
  const result = await db
    .prepare(SEAL_EXACT_BROWSER_VISITOR_DAY_SQL)
    .bind(
      closeAt,
      input.now,
      input.app_id,
      input.environment_id,
      closeAt,
      input.now,
      input.workspace_id,
      bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
      input.now,
      bounds.from,
      input.now,
      closeAt,
      closeAt,
      bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
      closeAt,
      input.workspace_id,
      input.app_id,
      input.environment_id,
      input.day,
      input.now,
      bounds.to + BROWSER_VISITOR_RETENTION_MS,
    )
    .run();
  return result.success && result.meta.changes === 1;
}

export function browserVisitorDayIsComplete(
  day: string,
  coverage: { sourceCutoverAt: number | null; reconciledThrough: number | null },
  now: number,
): boolean {
  const bounds = indiaDayBounds(day);
  const { sourceCutoverAt, reconciledThrough } = coverage;
  if (
    !bounds ||
    sourceCutoverAt === null ||
    reconciledThrough === null ||
    !Number.isSafeInteger(sourceCutoverAt) ||
    !Number.isSafeInteger(reconciledThrough)
  )
    return false;
  return (
    bounds.from >= sourceCutoverAt + BROWSER_VISITOR_MAX_FUTURE_SKEW_MS &&
    now >= bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS &&
    bounds.to <= reconciledThrough &&
    now < bounds.to + BROWSER_VISITOR_RETENTION_MS
  );
}

async function batchFingerprint(batch: CollectedBrowserBatch, days: readonly string[]) {
  const input = JSON.stringify([
    batch.workspace,
    batch.app_id,
    batch.environment_id,
    batch.batch_id,
    batch.visitor_hash ?? null,
    days,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Commit an idempotent acceptance receipt, event-day index and optional visitor/day set.
 * Call only after Queue.send succeeds and before returning HTTP 202.
 */
export async function acceptBrowserVisitorBatch(
  db: D1DatabaseLike,
  batch: CollectedBrowserBatch,
  now: number,
): Promise<void> {
  if (!batch.events.length) return;
  if (batch.events.length > MAX_BROWSER_VISITOR_RECEIPT_EVENTS)
    throw new Error('Browser receipt batch exceeds the event limit');
  const visitorHash = batch.visitor_hash;
  if (visitorHash !== undefined && !VISITOR_HASH.test(visitorHash))
    throw new Error('Invalid scoped browser visitor hash');
  const normalizedBatch = {
    ...batch,
    ...(visitorHash === undefined ? {} : { visitor_hash: visitorHash.toLowerCase() }),
  };
  const days = [
    ...new Set(batch.events.map((event) => indiaDayForTimestamp(event.timestamp))),
  ].sort();
  const dayExpiries = days.map((day) => {
    const bounds = indiaDayBounds(day);
    if (!bounds) throw new Error('Invalid India calendar day');
    return bounds.to + BROWSER_VISITOR_RETENTION_MS;
  });
  const fingerprint = await batchFingerprint(normalizedBatch, days);
  const factsDigest = await digestBrowserEventFacts(normalizedBatch);
  if (
    (batch.facts_digest_version !== undefined &&
      batch.facts_digest_version !== BROWSER_EVENT_FACTS_DIGEST_VERSION) ||
    (batch.facts_digest !== undefined && batch.facts_digest !== factsDigest)
  )
    throw new Error('Browser event facts digest mismatch');
  const dayPlaceholders = days.map(() => '?').join(', ');
  const openFenceCountSql = `(
    SELECT COUNT(*) FROM browser_visitor_acceptance_day_fences fence
    WHERE fence.workspace_id = ? AND fence.app_id = ? AND fence.environment_id = ?
      AND fence.india_day IN (${dayPlaceholders}) AND fence.state = 'open')`;
  const openFencesSql = `${openFenceCountSql} = ?`;
  const openFencesBindings = [
    batch.workspace,
    batch.app_id,
    batch.environment_id,
    ...days,
    days.length,
  ];
  const fenceCountBindings = openFencesBindings.slice(0, -1);
  const statements = [
    ...days.map((day, index) =>
      db
        .prepare(
          `INSERT INTO browser_visitor_acceptance_day_fences
             (workspace_id, app_id, environment_id, india_day, state, expires_at)
           VALUES (?, ?, ?, ?, 'open', ?) ON CONFLICT DO NOTHING`,
        )
        .bind(batch.workspace, batch.app_id, batch.environment_id, day, dayExpiries[index]),
    ),
    db
      .prepare(
        `INSERT INTO browser_visitor_rollup_meta (workspace_id, first_receipt_at)
         SELECT ?, ? WHERE ${openFencesSql}
         ON CONFLICT (workspace_id) DO NOTHING`,
      )
      .bind(batch.workspace, now, ...openFencesBindings),
    db
      .prepare(
        `INSERT INTO browser_visitor_batch_receipts
           (workspace_id, app_id, environment_id, batch_id, fingerprint, expires_at, accepted_at, event_count,
            facts_digest_version, facts_digest)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${openFencesSql}
         ON CONFLICT (workspace_id, app_id, environment_id, batch_id)
         DO UPDATE SET expires_at = MAX(browser_visitor_batch_receipts.expires_at, excluded.expires_at)
         WHERE browser_visitor_batch_receipts.fingerprint = excluded.fingerprint
           AND (browser_visitor_batch_receipts.facts_digest IS NULL
             OR (browser_visitor_batch_receipts.facts_digest_version = excluded.facts_digest_version
               AND browser_visitor_batch_receipts.facts_digest = excluded.facts_digest))
           AND (browser_visitor_batch_receipts.event_count IS NULL
             OR browser_visitor_batch_receipts.event_count = excluded.event_count)
           AND ${openFencesSql}`,
      )
      .bind(
        batch.workspace,
        batch.app_id,
        batch.environment_id,
        batch.batch_id,
        fingerprint,
        now + RECEIPT_RETENTION_MS,
        now,
        batch.events.length,
        BROWSER_EVENT_FACTS_DIGEST_VERSION,
        factsDigest,
        ...openFencesBindings,
        ...openFencesBindings,
      ),
  ];
  for (const day of days) {
    const bounds = indiaDayBounds(day);
    if (!bounds) throw new Error('Invalid India calendar day');
    statements.push(
      db
        .prepare(
          `INSERT INTO browser_visitor_receipt_days
             (workspace_id, app_id, environment_id, batch_id, india_day)
           SELECT ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM browser_visitor_batch_receipts
             WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
               AND batch_id = ? AND fingerprint = ?
               AND accepted_at IS NOT NULL AND event_count = ?
           )
           AND ${openFencesSql}
           ON CONFLICT (workspace_id, app_id, environment_id, batch_id, india_day) DO NOTHING`,
        )
        .bind(
          batch.workspace,
          batch.app_id,
          batch.environment_id,
          batch.batch_id,
          day,
          batch.workspace,
          batch.app_id,
          batch.environment_id,
          batch.batch_id,
          fingerprint,
          batch.events.length,
          ...openFencesBindings,
        ),
    );
    if (visitorHash === undefined) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO browser_visitor_days
             (workspace_id, app_id, environment_id, india_day, visitor_hash, expires_at)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM browser_visitor_batch_receipts
             WHERE workspace_id = ? AND app_id = ? AND environment_id = ?
               AND batch_id = ? AND fingerprint = ?
               AND accepted_at IS NOT NULL AND event_count = ?
           )
           AND ${openFencesSql}
           ON CONFLICT (workspace_id, app_id, environment_id, india_day, visitor_hash)
           DO UPDATE SET expires_at = MAX(browser_visitor_days.expires_at, excluded.expires_at)`,
        )
        .bind(
          batch.workspace,
          batch.app_id,
          batch.environment_id,
          day,
          visitorHash.toLowerCase(),
          bounds.to + BROWSER_VISITOR_RETENTION_MS,
          batch.workspace,
          batch.app_id,
          batch.environment_id,
          batch.batch_id,
          fingerprint,
          batch.events.length,
          ...openFencesBindings,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `SELECT receipt.fingerprint, receipt.accepted_at, receipt.event_count,
                receipt.facts_digest_version, receipt.facts_digest,
                (SELECT COUNT(*) FROM browser_visitor_receipt_days day_receipt
                 WHERE day_receipt.workspace_id = receipt.workspace_id
                   AND day_receipt.app_id = receipt.app_id
                   AND day_receipt.environment_id = receipt.environment_id
                   AND day_receipt.batch_id = receipt.batch_id
                   AND day_receipt.india_day IN (${dayPlaceholders})) AS indexed_days,
                ${openFenceCountSql} AS open_fence_count
         FROM browser_visitor_batch_receipts receipt
         WHERE receipt.workspace_id = ? AND receipt.app_id = ?
           AND receipt.environment_id = ? AND receipt.batch_id = ?`,
      )
      .bind(
        ...days,
        ...fenceCountBindings,
        batch.workspace,
        batch.app_id,
        batch.environment_id,
        batch.batch_id,
      ),
  );
  const results = await db.batch(statements);
  const receipt = results.at(-1)?.results?.[0] as
    | {
        fingerprint: string;
        accepted_at: number | null;
        event_count: number | null;
        facts_digest_version: number | null;
        facts_digest: string | null;
        indexed_days: number;
        open_fence_count: number;
      }
    | undefined;
  const legacyUnverifiedReceipt =
    receipt?.facts_digest_version === null && receipt.facts_digest === null;
  const matchingLegacyReceipt =
    legacyUnverifiedReceipt &&
    receipt.fingerprint === fingerprint &&
    (receipt.event_count === null || receipt.event_count === batch.events.length);
  const indexedReceipt =
    receipt?.accepted_at !== null &&
    receipt?.event_count === batch.events.length &&
    receipt?.indexed_days === days.length &&
    (receipt?.open_fence_count === days.length || receipt?.open_fence_count === 0);
  if (!receipt)
    throw new Error('Browser batch acceptance was blocked by a sealed or incomplete event day');
  if (
    receipt?.fingerprint !== fingerprint ||
    (!matchingLegacyReceipt &&
      (!indexedReceipt ||
        receipt.facts_digest_version !== BROWSER_EVENT_FACTS_DIGEST_VERSION ||
        receipt.facts_digest !== factsDigest))
  )
    throw new Error('Browser batch identity reused with different facts');
}

/** Read one bounded page of accepted batch receipts that included an event on an India day. */
export async function readBrowserVisitorReceiptPage(
  db: D1DatabaseLike,
  workspace: string,
  scopes: readonly ExactBrowserVisitorScope[],
  day: string,
  limit = MAX_BROWSER_VISITOR_RECEIPT_PAGE_SIZE,
  after?: BrowserVisitorReceiptCursor,
): Promise<BrowserVisitorReceiptPage> {
  if (!indiaDayBounds(day)) throw new Error('Invalid India calendar day');
  if (scopes.length > MAX_EXACT_BROWSER_VISITOR_SCOPES)
    throw new Error('Browser receipt query exceeds the bounded scope limit');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BROWSER_VISITOR_RECEIPT_PAGE_SIZE)
    throw new Error('Browser receipt page size exceeds the bounded query limit');
  const scopeKeys = scopes.map((scope) => JSON.stringify([scope.app_id, scope.environment_id]));
  if (new Set(scopeKeys).size !== scopeKeys.length)
    throw new Error('Duplicate browser receipt scope');
  if (!scopes.length) return { receipts: [], next_cursor: null };
  const cursorClause = after
    ? 'AND (receipt.app_id, receipt.environment_id, receipt.batch_id) > (?, ?, ?)'
    : '';
  const bindings: unknown[] = [
    JSON.stringify(scopes.map((scope) => [scope.app_id, scope.environment_id])),
    workspace,
    day,
  ];
  if (after) bindings.push(after.app_id, after.environment_id, after.batch_id);
  bindings.push(limit + 1);
  const result = await db
    .prepare(
      `WITH requested AS (
         SELECT json_extract(value, '$[0]') AS app_id,
                json_extract(value, '$[1]') AS environment_id
         FROM json_each(?)
       )
       SELECT receipt.app_id, receipt.environment_id, receipt.batch_id,
              receipt.fingerprint, receipt.accepted_at, receipt.event_count,
              receipt.facts_digest_version, receipt.facts_digest
       FROM requested
       JOIN browser_visitor_receipt_days day_receipt
         ON day_receipt.workspace_id = ?
         AND day_receipt.app_id = requested.app_id
         AND day_receipt.environment_id = requested.environment_id
         AND day_receipt.india_day = ?
       JOIN browser_visitor_batch_receipts receipt
         ON receipt.workspace_id = day_receipt.workspace_id
         AND receipt.app_id = day_receipt.app_id
         AND receipt.environment_id = day_receipt.environment_id
         AND receipt.batch_id = day_receipt.batch_id
       ${cursorClause}
       ORDER BY receipt.app_id, receipt.environment_id, receipt.batch_id
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<{
      app_id: string;
      environment_id: string;
      batch_id: string;
      fingerprint: string;
      accepted_at: number | null;
      event_count: number | null;
      facts_digest_version: number | null;
      facts_digest: string | null;
    }>();
  if (result.results.length > limit)
    return {
      receipts: result.results.slice(0, limit),
      next_cursor: (() => {
        const last = result.results[limit - 1];
        return last
          ? { app_id: last.app_id, environment_id: last.environment_id, batch_id: last.batch_id }
          : null;
      })(),
    };
  const receipts = result.results;
  return { receipts, next_cursor: null };
}

/**
 * Return null/Unknown until activation, late-event closure and retained coverage
 * all permit an exact read. A complete empty day is deliberately returned as 0.
 */
const READ_EXACT_BROWSER_VISITOR_DAYS_SQL = `WITH requested AS (
         SELECT json_extract(value, '$[0]') AS app_id,
                json_extract(value, '$[1]') AS environment_id
         FROM json_each(?)
       )
       SELECT requested.app_id, requested.environment_id,
         EXISTS (
           SELECT 1 FROM browser_visitor_acceptance_day_fences fence
           JOIN browser_visitor_acceptance_rollouts rollout
             ON rollout.workspace_id = fence.workspace_id
            AND rollout.generation_id = fence.rollout_generation_id
           JOIN browser_visitor_coverage_audits worker_audit
             ON worker_audit.workspace_id = fence.workspace_id
            AND worker_audit.audit_id = fence.worker_audit_id
           JOIN browser_visitor_coverage_audits scope_audit
             ON scope_audit.workspace_id = fence.workspace_id
            AND scope_audit.audit_id = fence.scope_audit_id
           JOIN browser_visitor_scope_activations activation
             ON activation.workspace_id = fence.workspace_id
            AND activation.app_id = fence.app_id
            AND activation.environment_id = fence.environment_id
            AND activation.activated_at = fence.tracker_activation_at
            AND activation.tracker_source_sha = fence.tracker_source_sha
           JOIN environments production_environment
             ON production_environment.id = activation.environment_id
            AND production_environment.app_id = activation.app_id
            AND lower(production_environment.name) = 'production'
           JOIN workspace_apps owned_app
             ON owned_app.workspace_id = activation.workspace_id
            AND owned_app.app_id = activation.app_id
           WHERE fence.workspace_id = ? AND fence.app_id = requested.app_id
             AND fence.environment_id = requested.environment_id AND fence.india_day = ?
             AND fence.state = 'sealed' AND fence.sealed_at >= ? AND fence.sealed_at <= ?
             AND fence.expires_at > ?
             AND rollout.full_traffic_percent = 100
             AND rollout.full_traffic_at <= ? AND rollout.full_traffic_observed_at <= fence.sealed_at
             AND worker_audit.audit_kind = 'worker_rollouts'
             AND worker_audit.audited_through >= ? AND worker_audit.observed_at <= fence.sealed_at
             AND scope_audit.audit_kind = 'tracker_scope'
             AND scope_audit.app_id = requested.app_id
             AND scope_audit.environment_id = requested.environment_id
             AND scope_audit.audited_through >= ? AND scope_audit.observed_at <= fence.sealed_at
             AND activation.activated_at <= ? AND activation.verified_at <= fence.sealed_at
             AND (activation.deactivated_at IS NULL OR activation.deactivated_at >= ?)
             AND (SELECT COUNT(*) FROM browser_visitor_scope_activations overlapping
                  WHERE overlapping.workspace_id = activation.workspace_id
                    AND overlapping.app_id = activation.app_id
                    AND overlapping.environment_id = activation.environment_id
                    AND overlapping.activated_at < ?
                    AND (overlapping.deactivated_at IS NULL OR overlapping.deactivated_at > ?)
                 ) = 1
             AND NOT EXISTS (
               SELECT 1 FROM browser_visitor_acceptance_rollouts interrupted
               WHERE interrupted.workspace_id = rollout.workspace_id
               AND interrupted.generation_id != rollout.generation_id
                 AND interrupted.rollout_started_at >= rollout.full_traffic_at
                 AND interrupted.rollout_started_at <= ?
             )
         ) AS coverage_sealed,
         COUNT(visitors.visitor_hash) AS visitors
       FROM requested
       LEFT JOIN browser_visitor_days visitors ON visitors.workspace_id = ?
         AND visitors.app_id = requested.app_id
         AND visitors.environment_id = requested.environment_id
         AND visitors.india_day = ?
         AND visitors.expires_at > ?
       GROUP BY requested.app_id, requested.environment_id
       ORDER BY requested.app_id, requested.environment_id
       LIMIT ${MAX_EXACT_BROWSER_VISITOR_SCOPES + 1}`;

export async function readExactBrowserVisitorDays(
  db: D1DatabaseLike,
  workspace: string,
  scopes: readonly ExactBrowserVisitorScope[],
  day: string,
  now: number,
): Promise<ExactBrowserVisitorResult[]> {
  const bounds = indiaDayBounds(day);
  if (!bounds) throw new Error('Invalid India calendar day');
  if (scopes.length > MAX_EXACT_BROWSER_VISITOR_SCOPES)
    throw new Error('Exact browser visitor scope exceeds the bounded query limit');
  if (!scopes.length) return [];
  if (!validProofTimestamp(now)) throw new Error('Invalid exact browser visitor read time');
  const scopeKeys = scopes.map((scope) => JSON.stringify([scope.app_id, scope.environment_id]));
  if (new Set(scopeKeys).size !== scopeKeys.length)
    throw new Error('Duplicate exact browser visitor scope');
  const lateClosureAt =
    bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
  const result = await db
    .prepare(READ_EXACT_BROWSER_VISITOR_DAYS_SQL)
    .bind(
      JSON.stringify(scopes.map((scope) => [scope.app_id, scope.environment_id])),
      workspace,
      day,
      lateClosureAt,
      now,
      now,
      bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
      lateClosureAt,
      lateClosureAt,
      bounds.from,
      lateClosureAt,
      lateClosureAt,
      bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
      lateClosureAt,
      workspace,
      day,
      now,
    )
    .all<{
      app_id: string;
      environment_id: string;
      coverage_sealed: number;
      visitors: number;
    }>();
  const allowed = new Set(scopeKeys);
  if (
    result.results.length !== scopes.length ||
    result.results.length > MAX_EXACT_BROWSER_VISITOR_SCOPES
  )
    throw new Error('Exact browser visitor query returned an incomplete scope');
  const seen = new Set<string>();
  return result.results.map((row) => {
    const key = JSON.stringify([row.app_id, row.environment_id]);
    const count = Number(row.visitors);
    if (!allowed.has(key) || seen.has(key) || !Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid exact browser visitor result');
    seen.add(key);
    const isComplete =
      row.coverage_sealed === 1 &&
      now >= lateClosureAt &&
      now < bounds.to + BROWSER_VISITOR_RETENTION_MS;
    return isComplete
      ? { app_id: row.app_id, environment_id: row.environment_id, complete: true, visitors: count }
      : { app_id: row.app_id, environment_id: row.environment_id, complete: false, visitors: null };
  });
}

async function deleteExpiredBrowserVisitorRows(db: D1DatabaseLike, now: number, limit: number) {
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM browser_visitor_days WHERE rowid IN (
           SELECT rowid FROM browser_visitor_days WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM browser_visitor_receipt_days
         WHERE (workspace_id, app_id, environment_id, batch_id) IN (
           SELECT workspace_id, app_id, environment_id, batch_id
           FROM browser_visitor_batch_receipts WHERE expires_at <= ?
           ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM browser_visitor_batch_receipts WHERE rowid IN (
           SELECT rowid FROM browser_visitor_batch_receipts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM browser_queue_stage_receipts WHERE rowid IN (
           SELECT rowid FROM browser_queue_stage_receipts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM browser_visitor_acceptance_day_fences WHERE rowid IN (
           SELECT rowid FROM browser_visitor_acceptance_day_fences
           WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, limit),
    db
      .prepare(
        `DELETE FROM browser_visitor_coverage_audits WHERE rowid IN (
           SELECT audit.rowid FROM browser_visitor_coverage_audits audit
           WHERE audit.audited_through <= ?
             AND NOT EXISTS (
               SELECT 1 FROM browser_visitor_acceptance_day_fences fence
               WHERE fence.workspace_id = audit.workspace_id
                 AND (fence.worker_audit_id = audit.audit_id OR fence.scope_audit_id = audit.audit_id)
             )
           ORDER BY audit.audited_through LIMIT ?
         )`,
      )
      .bind(now - BROWSER_VISITOR_RETENTION_MS, limit),
  ]);
  if (results.some((result) => !result.success))
    throw new Error('Browser visitor retention failed');
  return results;
}

async function findExpiredBrowserVisitorBacklog(db: D1DatabaseLike, now: number) {
  const [expiredVisitors, expiredReceipts, expiredFences, expiredAudits] = await Promise.all([
    db
      .prepare('SELECT 1 AS expired FROM browser_visitor_days WHERE expires_at <= ? LIMIT 1')
      .bind(now)
      .first<{ expired: number }>(),
    db
      .prepare(
        `SELECT 1 AS expired FROM browser_visitor_batch_receipts WHERE expires_at <= ?
         UNION ALL
         SELECT 1 AS expired FROM browser_queue_stage_receipts WHERE expires_at <= ? LIMIT 1`,
      )
      .bind(now, now)
      .first<{ expired: number }>(),
    db
      .prepare(
        'SELECT 1 AS expired FROM browser_visitor_acceptance_day_fences WHERE expires_at <= ? LIMIT 1',
      )
      .bind(now)
      .first<{ expired: number }>(),
    db
      .prepare(
        `SELECT 1 AS expired FROM browser_visitor_coverage_audits audit
         WHERE audit.audited_through <= ? AND NOT EXISTS (
           SELECT 1 FROM browser_visitor_acceptance_day_fences fence
           WHERE fence.workspace_id = audit.workspace_id
             AND (fence.worker_audit_id = audit.audit_id OR fence.scope_audit_id = audit.audit_id)
         ) LIMIT 1`,
      )
      .bind(now - BROWSER_VISITOR_RETENTION_MS)
      .first<{ expired: number }>(),
  ]);
  return {
    visitors: expiredVisitors !== null,
    receipts: expiredReceipts !== null,
    fences: expiredFences !== null,
    audits: expiredAudits !== null,
  };
}

export async function cleanupBrowserVisitorDays(
  db: D1DatabaseLike,
  now: number,
  limit = 1000,
): Promise<{
  visitors: number;
  receipts: number;
  fences: number;
  audits: number;
  backlog: { visitors: boolean; receipts: boolean; fences: boolean; audits: boolean };
}> {
  const boundedLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_RETENTION_ROWS_PER_TABLE_PER_RUN)
      : MAX_RETENTION_ROWS_PER_TABLE_PER_RUN;
  const results = await deleteExpiredBrowserVisitorRows(db, now, boundedLimit);
  const backlog = await findExpiredBrowserVisitorBacklog(db, now);
  return {
    visitors: results[0]?.meta.changes ?? 0,
    receipts: (results[2]?.meta.changes ?? 0) + (results[3]?.meta.changes ?? 0),
    fences: results[4]?.meta.changes ?? 0,
    audits: results[5]?.meta.changes ?? 0,
    backlog,
  };
}
