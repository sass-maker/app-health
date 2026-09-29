import type { CollectedBrowserBatch } from './browser-analytics.js';
import type { D1DatabaseLike } from './d1-adapter.js';

export const INDIA_OFFSET_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000;
export const BROWSER_VISITOR_DAY_MS = 86_400_000;
export const BROWSER_VISITOR_MAX_LATENESS_MS = BROWSER_VISITOR_DAY_MS;
export const BROWSER_VISITOR_MAX_FUTURE_SKEW_MS = 60_000;
/** Provisional bounded retention; validate briefing lookback and D1 growth before release. */
export const BROWSER_VISITOR_RETENTION_DAYS = 35;
const BROWSER_VISITOR_RETENTION_MS = BROWSER_VISITOR_RETENTION_DAYS * BROWSER_VISITOR_DAY_MS;
const RECEIPT_RETENTION_MS = BROWSER_VISITOR_RETENTION_MS;
const VISITOR_HASH = /^[a-f0-9]{64}$/i;
const MAX_RETENTION_ROWS_PER_TABLE_PER_RUN = 10_000;
export const MAX_EXACT_BROWSER_VISITOR_SCOPES = 128;

export type ExactBrowserVisitorDay =
  { complete: true; visitors: number } | { complete: false; visitors: null };
export type ExactBrowserVisitorScope = { app_id: string; environment_id: string };
export type ExactBrowserVisitorResult = ExactBrowserVisitorScope & ExactBrowserVisitorDay;

export function indiaDayForTimestamp(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error('Invalid browser event timestamp');
  return new Date(timestamp + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

export function indiaDayBounds(day: string): { from: number; to: number } | null {
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
 * Commit an idempotent visitor/day set and its coverage activation metadata.
 * Call only after Queue.send succeeds and before returning HTTP 202.
 */
export async function acceptBrowserVisitorBatch(
  db: D1DatabaseLike,
  batch: CollectedBrowserBatch,
  now: number,
): Promise<void> {
  if (!batch.events.length) return;
  const visitorHash = batch.visitor_hash;
  if (visitorHash === undefined) return;
  if (!VISITOR_HASH.test(visitorHash)) throw new Error('Invalid scoped browser visitor hash');
  const normalizedBatch = { ...batch, visitor_hash: visitorHash.toLowerCase() };
  const days = [
    ...new Set(batch.events.map((event) => indiaDayForTimestamp(event.timestamp))),
  ].sort();
  const fingerprint = await batchFingerprint(normalizedBatch, days);
  const statements = [
    db
      .prepare(
        `INSERT INTO browser_visitor_rollup_meta (workspace_id, first_receipt_at)
         VALUES (?, ?) ON CONFLICT (workspace_id) DO NOTHING`,
      )
      .bind(batch.workspace, now),
    db
      .prepare(
        `INSERT INTO browser_visitor_batch_receipts
           (workspace_id, app_id, environment_id, batch_id, fingerprint, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, app_id, environment_id, batch_id)
         DO UPDATE SET expires_at = MAX(browser_visitor_batch_receipts.expires_at, excluded.expires_at)
         WHERE browser_visitor_batch_receipts.fingerprint = excluded.fingerprint`,
      )
      .bind(
        batch.workspace,
        batch.app_id,
        batch.environment_id,
        batch.batch_id,
        fingerprint,
        now + RECEIPT_RETENTION_MS,
      ),
  ];
  for (const day of days) {
    const bounds = indiaDayBounds(day);
    if (!bounds) throw new Error('Invalid India calendar day');
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
           )
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
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `SELECT fingerprint FROM browser_visitor_batch_receipts
         WHERE workspace_id = ? AND app_id = ? AND environment_id = ? AND batch_id = ?`,
      )
      .bind(batch.workspace, batch.app_id, batch.environment_id, batch.batch_id),
  );
  const results = await db.batch(statements);
  const receipt = results.at(-1)?.results?.[0]?.fingerprint;
  if (receipt !== fingerprint)
    throw new Error('Browser batch identity reused with different facts');
}

/**
 * Return null/Unknown until activation, late-event closure and retained coverage
 * all permit an exact read. A complete empty day is deliberately returned as 0.
 */
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
  const scopeKeys = scopes.map((scope) => JSON.stringify([scope.app_id, scope.environment_id]));
  if (new Set(scopeKeys).size !== scopeKeys.length)
    throw new Error('Duplicate exact browser visitor scope');
  const result = await db
    .prepare(
      `WITH requested AS (
         SELECT json_extract(value, '$[0]') AS app_id,
                json_extract(value, '$[1]') AS environment_id
         FROM json_each(?)
       )
       SELECT requested.app_id, requested.environment_id,
         meta.source_cutover_at, meta.reconciled_through, meta.verified_at,
         COUNT(visitors.visitor_hash) AS visitors
       FROM requested
       LEFT JOIN browser_visitor_rollup_meta meta ON meta.workspace_id = ?
       LEFT JOIN browser_visitor_days visitors ON visitors.workspace_id = ?
         AND visitors.app_id = requested.app_id
         AND visitors.environment_id = requested.environment_id
         AND visitors.india_day = ?
       GROUP BY requested.app_id, requested.environment_id,
         meta.source_cutover_at, meta.reconciled_through, meta.verified_at
       ORDER BY requested.app_id, requested.environment_id
       LIMIT ${MAX_EXACT_BROWSER_VISITOR_SCOPES + 1}`,
    )
    .bind(
      JSON.stringify(scopes.map((scope) => [scope.app_id, scope.environment_id])),
      workspace,
      workspace,
      day,
    )
    .all<{
      app_id: string;
      environment_id: string;
      source_cutover_at: number | null;
      reconciled_through: number | null;
      verified_at: number | null;
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
      row.verified_at !== null &&
      row.verified_at <= now &&
      row.verified_at >= bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS &&
      browserVisitorDayIsComplete(
        day,
        {
          sourceCutoverAt: row.source_cutover_at,
          reconciledThrough: row.reconciled_through,
        },
        now,
      );
    return isComplete
      ? { app_id: row.app_id, environment_id: row.environment_id, complete: true, visitors: count }
      : { app_id: row.app_id, environment_id: row.environment_id, complete: false, visitors: null };
  });
}

export async function cleanupBrowserVisitorDays(
  db: D1DatabaseLike,
  now: number,
  limit = 1000,
): Promise<{
  visitors: number;
  receipts: number;
  backlog: { visitors: boolean; receipts: boolean };
}> {
  const boundedLimit =
    Number.isInteger(limit) && limit > 0
      ? Math.min(limit, MAX_RETENTION_ROWS_PER_TABLE_PER_RUN)
      : MAX_RETENTION_ROWS_PER_TABLE_PER_RUN;
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM browser_visitor_days WHERE rowid IN (
           SELECT rowid FROM browser_visitor_days WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, boundedLimit),
    db
      .prepare(
        `DELETE FROM browser_visitor_batch_receipts WHERE rowid IN (
           SELECT rowid FROM browser_visitor_batch_receipts WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
      )
      .bind(now, boundedLimit),
  ]);
  if (results.some((result) => !result.success))
    throw new Error('Browser visitor retention failed');
  const [expiredVisitors, expiredReceipts] = await Promise.all([
    db
      .prepare('SELECT 1 AS expired FROM browser_visitor_days WHERE expires_at <= ? LIMIT 1')
      .bind(now)
      .first<{ expired: number }>(),
    db
      .prepare(
        'SELECT 1 AS expired FROM browser_visitor_batch_receipts WHERE expires_at <= ? LIMIT 1',
      )
      .bind(now)
      .first<{ expired: number }>(),
  ]);
  return {
    visitors: results[0]?.meta.changes ?? 0,
    receipts: results[1]?.meta.changes ?? 0,
    backlog: {
      visitors: expiredVisitors !== null,
      receipts: expiredReceipts !== null,
    },
  };
}
