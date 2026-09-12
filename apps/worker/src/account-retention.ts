import type { D1DatabaseLike } from './d1-adapter.js';

const ACCOUNT_RETENTION_BATCH_SIZE = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

export interface AccountRetentionResult {
  ok: boolean;
  sessions: number;
  verifications: number;
  rateLimits: number;
  error?: string;
}

function boundedLimit(limit: number): number {
  return Number.isInteger(limit) && limit > 0
    ? Math.min(limit, ACCOUNT_RETENTION_BATCH_SIZE)
    : ACCOUNT_RETENTION_BATCH_SIZE;
}

function expirySeconds(column: string): string {
  return `(CASE WHEN typeof(${column}) IN ('integer', 'real') OR (typeof(${column}) = 'text' AND trim(${column}) <> '' AND trim(${column}) NOT GLOB '*[^0-9.]*') THEN CAST(${column} AS REAL) / 1000.0 ELSE (julianday(${column}) - 2440587.5) * 86400.0 END)`;
}

export async function cleanupExpiredAccountRecords(
  db: D1DatabaseLike,
  nowMs = Date.now(),
  limit = ACCOUNT_RETENTION_BATCH_SIZE,
): Promise<AccountRetentionResult> {
  const rowLimit = boundedLimit(limit);
  const statements = [
    db
      .prepare(
        `DELETE FROM session WHERE id IN (SELECT id FROM session WHERE ${expirySeconds('expiresAt')} < ? LIMIT ?)`,
      )
      .bind(nowMs / 1000, rowLimit),
    db
      .prepare(
        `DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE ${expirySeconds('expiresAt')} < ? LIMIT ?)`,
      )
      .bind(nowMs / 1000, rowLimit),
    db
      .prepare(
        'DELETE FROM rateLimit WHERE id IN (SELECT id FROM rateLimit WHERE lastRequest < ? LIMIT ?)',
      )
      .bind(nowMs - RATE_LIMIT_WINDOW_MS, rowLimit),
  ];
  try {
    const results = await db.batch(statements);
    return {
      ok: true,
      sessions: results[0]?.meta.changes ?? 0,
      verifications: results[1]?.meta.changes ?? 0,
      rateLimits: results[2]?.meta.changes ?? 0,
    };
  } catch {
    return {
      ok: false,
      sessions: 0,
      verifications: 0,
      rateLimits: 0,
      error: 'account retention cleanup failed',
    };
  }
}
