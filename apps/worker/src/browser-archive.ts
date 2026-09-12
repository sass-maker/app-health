import { projectBrowserBatch } from './browser-projection.js';
import { DurableObject } from 'cloudflare:workers';
import type { CollectedBrowserBatch } from './browser-analytics.js';

const FLUSH_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 8 * FLUSH_BYTES;
const MAX_PENDING_BATCHES = 1024;
const MAX_LEDGER_BATCHES = 250_000;
const MAX_STAGE_BATCHES = 100;
const MAX_BATCH_BYTES = 64 * 1024;
const FLUSH_DELAY = 60_000;
const DEDUPE_RETENTION = 31 * 86_400_000;
const PROJECTION_BATCHES = 50;
const PROJECTION_MAX_BACKOFF = 60 * 60_000;

export interface BrowserArchiveEnvironment {
  BROWSER_HISTORY: Pick<R2Bucket, 'put' | 'list' | 'delete'>;
  BROWSER_ANALYTICS?: Pick<AnalyticsEngineDataset, 'writeDataPoint'>;
}
type BatchIdentity = Pick<CollectedBrowserBatch, 'app_id' | 'environment_id' | 'batch_id'>;
export interface BrowserArchiveStageResult {
  /** New identities only. A retry of a committed stage returns them as duplicates. */
  accepted: BatchIdentity[];
  duplicates: number;
}
interface PreparedBatch {
  identity: string;
  scope: BatchIdentity;
  workspace: string;
  payload: string;
  fingerprint: string;
  bytes: number;
}
type PendingRow = {
  identity: string;
  payload: string;
  bytes: number;
};
type ProjectionRow = { identity: string; payload: string; attempts: number };

type SegmentRow = {
  id: string;
  object_key: string;
};
type ArchiveStats = {
  pending_batches: number;
  pending_bytes: number;
  ledger_batches: number;
};

async function prepareBatch(batch: CollectedBrowserBatch): Promise<PreparedBatch> {
  const names = [batch.workspace, batch.app_id, batch.environment_id, batch.batch_id];
  if (names.some((name) => typeof name !== 'string' || !name.length || name.length > 200))
    throw new Error('Invalid archive identity');
  if (!Array.isArray(batch.events) || !batch.events.length)
    throw new Error('Archive batches must contain events');
  const payload = JSON.stringify(batch);
  const bytes = new TextEncoder().encode(`${payload}\n`).byteLength;
  if (bytes > MAX_BATCH_BYTES) throw new Error('Archive batch exceeds 64 KiB');
  // Collector retries may update received_at without changing the accepted events.
  const content = JSON.stringify([
    ...names,
    batch.events,
    batch.session_hash,
    batch.visitor_hash,
    batch.visit_type,
    batch.attribution,
  ]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const fingerprint = Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join(
    '',
  );
  return {
    identity: JSON.stringify(names.slice(1)),
    scope: { app_id: batch.app_id, environment_id: batch.environment_id, batch_id: batch.batch_id },
    workspace: batch.workspace,
    payload,
    fingerprint,
    bytes,
  };
}

/** Queue consumers route consistently by workspace + shard, including every retry. */
export class BrowserArchive extends DurableObject<BrowserArchiveEnvironment> {
  private flushing: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: BrowserArchiveEnvironment) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS archive_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1), workspace TEXT, retry_after INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO archive_meta (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS archive_seen (
        identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS archive_seen_expiry ON archive_seen(expires_at);
      CREATE TABLE IF NOT EXISTS archive_pending (
        identity TEXT PRIMARY KEY, payload TEXT NOT NULL, bytes INTEGER NOT NULL,
        added_at INTEGER NOT NULL, segment_id TEXT
      );
      CREATE INDEX IF NOT EXISTS archive_pending_segment ON archive_pending(segment_id, added_at);
      CREATE TABLE IF NOT EXISTS projection_pending (
        identity TEXT PRIMARY KEY, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, bytes INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projection_pending_due ON projection_pending(next_attempt_at, identity);
      CREATE TABLE IF NOT EXISTS projection_counts (
        id INTEGER PRIMARY KEY CHECK (id = 1), pending_batches INTEGER NOT NULL,
        pending_bytes INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO projection_counts (id, pending_batches, pending_bytes) VALUES (1, 0, 0);
      CREATE TRIGGER IF NOT EXISTS projection_pending_insert AFTER INSERT ON projection_pending BEGIN
        UPDATE projection_counts SET pending_batches = pending_batches + 1,
          pending_bytes = pending_bytes + NEW.bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS projection_pending_delete AFTER DELETE ON projection_pending BEGIN
        UPDATE projection_counts SET pending_batches = pending_batches - 1,
          pending_bytes = pending_bytes - OLD.bytes WHERE id = 1;
      END;
      CREATE TABLE IF NOT EXISTS archive_segments (id TEXT PRIMARY KEY, object_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_counts (
        id INTEGER PRIMARY KEY CHECK (id = 1), pending_batches INTEGER NOT NULL,
        pending_bytes INTEGER NOT NULL, ledger_batches INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS archive_seen_insert AFTER INSERT ON archive_seen BEGIN
        UPDATE archive_counts SET ledger_batches = ledger_batches + 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS archive_seen_delete AFTER DELETE ON archive_seen BEGIN
        UPDATE archive_counts SET ledger_batches = ledger_batches - 1 WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS archive_pending_insert AFTER INSERT ON archive_pending BEGIN
        UPDATE archive_counts SET pending_batches = pending_batches + 1,
          pending_bytes = pending_bytes + NEW.bytes WHERE id = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS archive_pending_delete AFTER DELETE ON archive_pending BEGIN
        UPDATE archive_counts SET pending_batches = pending_batches - 1,
          pending_bytes = pending_bytes - OLD.bytes WHERE id = 1;
      END;
    `);
    if (!ctx.storage.sql.exec('SELECT id FROM archive_counts WHERE id = 1').toArray().length)
      ctx.storage.sql.exec(`INSERT INTO archive_counts SELECT 1, COUNT(*), COALESCE(SUM(bytes), 0),
        (SELECT COUNT(*) FROM archive_seen) FROM archive_pending`);
    // Recover a committed stage whose caller died before installing its alarm.
    ctx.blockConcurrencyWhile(() => this.schedule());
  }

  async stage(batches: CollectedBrowserBatch[]): Promise<BrowserArchiveStageResult> {
    if (!Array.isArray(batches) || batches.length > MAX_STAGE_BATCHES)
      throw new Error('Archive stage exceeds 100 batches');
    const prepared = await Promise.all(batches.map(prepareBatch));
    const result = this.ctx.storage.transactionSync(() => this.insert(prepared));
    await this.schedule();
    await this.ctx.storage.sync();
    // Threshold flush runs as an alarm, so an R2 failure cannot lose a new-stage receipt.
    return result;
  }

  private insert(batches: PreparedBatch[]): BrowserArchiveStageResult {
    this.prune();
    const fresh = this.newBatches(batches);
    const stats = this.status();
    const projection = this.ctx.storage.sql
      .exec<{ pending_batches: number; pending_bytes: number }>(
        'SELECT pending_batches, pending_bytes FROM projection_counts WHERE id = 1',
      )
      .one();
    const bytes = fresh.reduce((total, batch) => total + batch.bytes, 0);
    if (
      projection.pending_batches + fresh.length > MAX_PENDING_BATCHES ||
      projection.pending_bytes + bytes > MAX_PENDING_BYTES ||
      stats.pending_batches + fresh.length > MAX_PENDING_BATCHES ||
      stats.pending_bytes + bytes > MAX_PENDING_BYTES ||
      stats.ledger_batches + fresh.length > MAX_LEDGER_BATCHES
    )
      throw new Error('Archive capacity exceeded; retry after archival drains');
    for (const batch of fresh) {
      this.ctx.storage.sql.exec(
        'INSERT INTO archive_seen (identity, fingerprint) VALUES (?, ?)',
        batch.identity,
        batch.fingerprint,
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO archive_pending (identity, payload, bytes, added_at) VALUES (?, ?, ?, ?)',
        batch.identity,
        batch.payload,
        batch.bytes,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        'INSERT INTO projection_pending (identity, payload, next_attempt_at, bytes) VALUES (?, ?, ?, ?) ON CONFLICT(identity) DO UPDATE SET payload = excluded.payload, attempts = 0, next_attempt_at = excluded.next_attempt_at, bytes = excluded.bytes',
        batch.identity,
        batch.payload,
        Date.now(),
        batch.bytes,
      );
    }
    return {
      accepted: fresh.map((batch) => batch.scope),
      duplicates: batches.length - fresh.length,
    };
  }

  private newBatches(batches: PreparedBatch[]): PreparedBatch[] {
    const workspace =
      this.ctx.storage.sql
        .exec<{ workspace: string | null }>('SELECT workspace FROM archive_meta WHERE id = 1')
        .one().workspace ?? batches[0]?.workspace;
    const fresh = new Map<string, PreparedBatch>();
    for (const batch of batches) {
      if (batch.workspace !== workspace) throw new Error('Archive shard workspace mismatch');
      const existing =
        fresh.get(batch.identity) ??
        this.ctx.storage.sql
          .exec<{ fingerprint: string }>(
            'SELECT fingerprint FROM archive_seen WHERE identity = ?',
            batch.identity,
          )
          .toArray()[0];
      if (existing && existing.fingerprint !== batch.fingerprint)
        throw new Error('Archive batch identity reused with different events');
      if (!existing) fresh.set(batch.identity, batch);
    }
    if (workspace)
      this.ctx.storage.sql.exec('UPDATE archive_meta SET workspace = ? WHERE id = 1', workspace);
    return [...fresh.values()];
  }

  status(): ArchiveStats {
    return this.ctx.storage.sql
      .exec<ArchiveStats>(
        'SELECT pending_batches, pending_bytes, ledger_batches FROM archive_counts WHERE id = 1',
      )
      .one();
  }

  private prune(): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM archive_seen WHERE identity IN (SELECT seen.identity FROM archive_seen seen LEFT JOIN projection_pending projection ON projection.identity = seen.identity WHERE seen.expires_at <= ? AND projection.identity IS NULL ORDER BY seen.expires_at LIMIT 1000)',
      Date.now(),
    );
  }

  private async schedule(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const stats = this.status();
    const meta = this.ctx.storage.sql
      .exec<{ retry_after: number }>('SELECT retry_after FROM archive_meta WHERE id = 1')
      .one();
    const expiry = this.ctx.storage.sql
      .exec<{ expiry: number | null }>(
        'SELECT MIN(seen.expires_at) AS expiry FROM archive_seen seen LEFT JOIN projection_pending projection ON projection.identity = seen.identity WHERE projection.identity IS NULL',
      )
      .one().expiry;
    const pending = this.ctx.storage.sql
      .exec<{ oldest: number | null }>('SELECT MIN(added_at) AS oldest FROM archive_pending')
      .one().oldest;
    const projection = this.ctx.storage.sql
      .exec<{ due: number | null }>('SELECT MIN(next_attempt_at) AS due FROM projection_pending')
      .one().due;
    const flushAt =
      pending === null
        ? Infinity
        : Math.max(
            meta.retry_after,
            stats.pending_bytes >= FLUSH_BYTES ? Date.now() : pending + FLUSH_DELAY,
          );
    const target = Math.max(
      Date.now() + 1000,
      Math.min(expiry ?? Infinity, flushAt, projection ?? Infinity),
    );
    if (Number.isFinite(target) && (current === null || target < current))
      await this.ctx.storage.setAlarm(target);
  }

  /** Also usable by a bounded operational drain; only one segment uploads at a time. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const operation = this.upload();
    this.flushing = operation;
    try {
      await operation;
    } finally {
      this.flushing = null;
    }
  }

  private seal(): SegmentRow | null {
    const existing = this.ctx.storage.sql
      .exec<SegmentRow>('SELECT id, object_key FROM archive_segments LIMIT 1')
      .toArray()[0];
    if (existing) return existing;
    const rows = this.ctx.storage.sql
      .exec<PendingRow>(
        'SELECT identity, payload, bytes FROM archive_pending WHERE segment_id IS NULL ORDER BY added_at, identity LIMIT 1024',
      )
      .toArray();
    if (!rows.length) return null;
    const id = crypto.randomUUID();
    const partition = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
    const object_key = `browser-v2/${partition}/${this.ctx.id.toString()}/${id}.jsonl.gz`;
    this.ctx.storage.sql.exec('INSERT INTO archive_segments VALUES (?, ?)', id, object_key);
    let bytes = 0;
    for (const row of rows) {
      if (bytes && bytes + row.bytes > FLUSH_BYTES) break;
      this.ctx.storage.sql.exec(
        'UPDATE archive_pending SET segment_id = ? WHERE identity = ?',
        id,
        row.identity,
      );
      bytes += row.bytes;
    }
    return { id, object_key };
  }

  private async upload(): Promise<void> {
    const segment = this.ctx.storage.transactionSync(() => this.seal());
    if (!segment) return;
    try {
      const rows = this.ctx.storage.sql
        .exec<PendingRow>(
          'SELECT identity, payload, bytes FROM archive_pending WHERE segment_id = ? ORDER BY added_at, identity',
          segment.id,
        )
        .toArray();
      const body = rows.map((row) => row.payload).join('\n') + '\n';
      const gzip = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
      // R2 requires known-length bodies; the sealed segment is capped at 1 MiB.
      const compressed = await new Response(gzip).arrayBuffer();
      await this.env.BROWSER_HISTORY.put(segment.object_key, compressed, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      });
      // Null means our immutable segment already exists after a lost response/restart.
      this.ctx.storage.transactionSync(() => this.complete(segment.id));
    } catch (error) {
      this.ctx.storage.sql.exec(
        'UPDATE archive_meta SET retry_after = ? WHERE id = 1',
        Date.now() + FLUSH_DELAY,
      );
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY);
      throw error;
    } finally {
      await this.schedule();
    }
  }

  private complete(segment: string): void {
    this.ctx.storage.sql.exec(
      'UPDATE archive_seen SET expires_at = ? WHERE identity IN (SELECT identity FROM archive_pending WHERE segment_id = ?)',
      Date.now() + DEDUPE_RETENTION,
      segment,
    );
    this.ctx.storage.sql.exec('DELETE FROM archive_pending WHERE segment_id = ?', segment);
    this.ctx.storage.sql.exec('DELETE FROM archive_segments WHERE id = ?', segment);
    this.ctx.storage.sql.exec('UPDATE archive_meta SET retry_after = 0 WHERE id = 1');
  }

  override async alarm(): Promise<void> {
    this.prune();
    const retry = this.ctx.storage.sql
      .exec<{ retry_after: number }>('SELECT retry_after FROM archive_meta WHERE id = 1')
      .one().retry_after;
    await this.projectPending();
    if (retry > Date.now()) {
      await this.schedule();
      return;
    }
    const oldest = this.ctx.storage.sql
      .exec<{ oldest: number | null }>('SELECT MIN(added_at) AS oldest FROM archive_pending')
      .one().oldest;
    if (
      oldest !== null &&
      (oldest + FLUSH_DELAY <= Date.now() || this.status().pending_bytes >= FLUSH_BYTES)
    )
      await this.flush();
    await this.schedule();
  }

  private async projectPending(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<ProjectionRow>(
        'SELECT identity, payload, attempts FROM projection_pending WHERE next_attempt_at <= ? ORDER BY next_attempt_at, identity LIMIT ?',
        Date.now(),
        PROJECTION_BATCHES,
      )
      .toArray();
    for (const row of rows) {
      try {
        projectBrowserBatch(JSON.parse(row.payload) as CollectedBrowserBatch, this.env);
        this.ctx.storage.sql.exec(
          'DELETE FROM projection_pending WHERE identity = ?',
          row.identity,
        );
      } catch {
        const attempts = Math.min(row.attempts + 1, 31);
        const backoff = Math.min(PROJECTION_MAX_BACKOFF, 1000 * 2 ** Math.min(attempts, 10));
        this.ctx.storage.sql.exec(
          'UPDATE projection_pending SET attempts = ?, next_attempt_at = ? WHERE identity = ?',
          attempts,
          Date.now() + backoff,
          row.identity,
        );
      }
    }
  }
}
