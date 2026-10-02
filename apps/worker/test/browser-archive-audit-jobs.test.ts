import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import type { BrowserEnvironment } from '../src/browser-routes.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import { handleBrowserOwner } from '../src/browser-routes.js';
import {
  cleanupExpiredBrowserArchiveAuditJobs,
  processBrowserArchiveAuditJob,
  processPendingBrowserArchiveAuditJobs,
  readBrowserArchiveAuditJob,
  startBrowserArchiveAuditJob,
} from '../src/browser-archive-audit-jobs.js';
import { acceptBrowserVisitorBatch } from '../src/browser-visitor-daily.js';

const DAY = '2026-09-29';
const WORKSPACE = 'workspace-a';
const OBJECT_KEY = 'browser-v2/2026-09-30/archive-shard-a/segment-a.jsonl.gz';
const REFERENCE = { segment_id: 'segment-a', object_key: OBJECT_KEY };
const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
  compatibilityDate: '2026-07-22',
  d1Databases: ['DB'],
  cf: false,
});
const batch: CollectedBrowserBatch = {
  workspace: WORKSPACE,
  app_id: 'app-private-id',
  environment_id: 'environment-private-id',
  batch_id: 'batch-private-id',
  received_at: Date.parse('2026-09-30T02:00:00Z'),
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
const db = await mf.getD1Database('DB');

async function applyMigration(name: string) {
  const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
  for (const statement of sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((part) => part.trim()))
    await db.prepare(statement).run();
}

async function archiveBody(batches: CollectedBrowserBatch[] = [batch], objectKey = OBJECT_KEY) {
  const archived = await Promise.all(
    batches.map(async (value) => ({
      ...value,
      facts_digest_version: 1,
      facts_digest: await digestBrowserEventFacts(value),
    })),
  );
  const raw = Buffer.from(archived.map((value) => `${JSON.stringify(value)}\n`).join(''));
  const compressed = gzipSync(raw);
  const manifest = {
    schema_version: 1,
    object_key: objectKey,
    workspace_id: WORKSPACE,
    format: 'jsonl-gzip',
    content_sha256: createHash('sha256').update(compressed).digest('hex'),
    row_count: batches.length,
    event_count: batches.reduce((count, value) => count + value.events.length, 0),
    min_event_at: batch.events[0]!.timestamp,
    max_event_at: batch.events[0]!.timestamp,
    uncompressed_bytes: raw.byteLength,
    compressed_bytes: compressed.byteLength,
    created_at: Date.now(),
    state: 'active',
  };
  return {
    body: new Response(compressed).body!,
    size: compressed.byteLength,
    customMetadata: { manifest: JSON.stringify(manifest) },
  } as unknown as R2ObjectBody;
}

let body: R2ObjectBody;
let forceSnapshotChange = false;
let shardZeroPageCalls = 0;
let batchLookupCalls = 0;
let dayPageCalls = 0;
const archive = {
  getByName(name: string) {
    const shard = Number(name.split(':').at(-1));
    return {
      archiveSegmentForBatch: async () => {
        batchLookupCalls++;
        return REFERENCE;
      },
      archiveSegmentsForEventDay: async (day: string) => {
        dayPageCalls++;
        if (forceSnapshotChange && shard === 0) {
          shardZeroPageCalls++;
          return {
            segments: [],
            next_cursor:
              shardZeroPageCalls === 1
                ? { event_day: day, object_key: 'cursor-key', snapshot_sequence: 1 }
                : null,
            snapshot_sequence: shardZeroPageCalls === 1 ? 1 : 2,
          };
        }
        return {
          segments: shard === 0 ? [REFERENCE] : [],
          next_cursor: null,
          snapshot_sequence: 1,
        };
      },
    };
  },
};
const history = { get: async (key: string) => (key === OBJECT_KEY ? body : null) };

beforeAll(async () => {
  await db
    .prepare(
      'CREATE TABLE environments (id TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (id, app_id))',
    )
    .run();
  await db
    .prepare('INSERT INTO environments (id, app_id) VALUES (?, ?)')
    .bind(batch.environment_id, batch.app_id)
    .run();
  await applyMigration('0019_browser_visitor_days.sql');
  await applyMigration('0020_browser_receipt_reconciliation.sql');
  await applyMigration('0021_browser_event_facts_digest.sql');
  await applyMigration('0022_browser_archive_audit_jobs.sql');
  await applyMigration('0023_browser_queue_stage_receipts.sql');
  await applyMigration('0024_browser_archive_queue_evidence.sql');
  await applyMigration('0025_browser_visitor_acceptance_coverage.sql');
  await applyMigration('0026_browser_visitor_day_seals.sql');
  body = await archiveBody();
});

beforeEach(async () => {
  forceSnapshotChange = false;
  shardZeroPageCalls = 0;
  batchLookupCalls = 0;
  dayPageCalls = 0;
  body = await archiveBody();
  await db.prepare('DELETE FROM browser_archive_audit_jobs').run();
  await db.prepare('DELETE FROM browser_visitor_days').run();
  await db.prepare('DELETE FROM browser_visitor_receipt_days').run();
  await db.prepare('DELETE FROM browser_visitor_batch_receipts').run();
  await db.prepare('DELETE FROM browser_queue_stage_receipts').run();
  await db.prepare('DELETE FROM browser_visitor_rollup_meta').run();
  await acceptBrowserVisitorBatch(db, batch, batch.received_at);
});

afterAll(() => mf.dispose());

describe('resumable browser archive audit jobs', () => {
  it('resumes a segment larger than the fact slice without skipping receipts or recounting facts', async () => {
    const batches = Array.from({ length: 40 }, (_, index) => ({
      ...batch,
      batch_id: index === 0 ? batch.batch_id : `large-segment-batch-${index}`,
    }));
    for (const value of batches.slice(1))
      await acceptBrowserVisitorBatch(db, value, value.received_at);
    const bindings = { db, archive, history: { get: async () => archiveBody(batches) } };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 200);
    const partial = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 201);
    expect(partial).toMatchObject({
      status: 'running',
      phase: 'receipts',
      progress: { receipts_processed: 0, segments_checked: 0, archive_facts_checked: 39 },
    });
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 300);
    const completedSegment = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 301);
    expect(completedSegment?.progress).toMatchObject({
      receipts_processed: 30,
      segments_checked: 1,
      archive_facts_checked: 40,
    });
    for (let tick = 0; tick < 8; tick++)
      await processPendingBrowserArchiveAuditJobs(bindings, 400 + tick * 10);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1000);
    expect(finished).toMatchObject({ status: 'finished', complete: false });
    expect(finished?.progress).toMatchObject({ receipts_processed: 40, archive_facts_checked: 40 });
    expect(finished?.observed_comparison_counts).toMatchObject({
      matched: 40,
      mismatched: 0,
      archive_only_facts: 0,
      duplicate_archive_candidates: 0,
    });
  });

  it('resumes an archive-only segment before revisiting an earlier unfinished shard', async () => {
    const indexed = Array.from({ length: 40 }, (_, index) => ({
      ...batch,
      batch_id: `indexed-segment-batch-${index}`,
    }));
    const indexedKey = OBJECT_KEY.replace('segment-a', 'segment-b');
    const indexedRef = { segment_id: 'segment-b', object_key: indexedKey };
    const indexedArchive = {
      getByName(name: string) {
        const shard = Number(name.split(':').at(-1));
        return {
          archiveSegmentForBatch: async () => REFERENCE,
          archiveSegmentsForEventDay: async (day: string, cursor: unknown) => ({
            segments: shard === 1 ? [indexedRef] : [],
            next_cursor:
              shard === 0 && !cursor
                ? { event_day: day, object_key: 'next-page', snapshot_sequence: 1 }
                : null,
            snapshot_sequence: 1,
          }),
        };
      },
    };
    const bindings = {
      db,
      archive: indexedArchive,
      history: {
        get: async (key: string) => archiveBody(key === indexedKey ? indexed : [batch], key),
      },
    };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 200);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 300);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 400);
    const partial = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 401);
    expect(partial).toMatchObject({
      status: 'running',
      phase: 'archive_index',
      progress: { segments_checked: 1, archive_facts_checked: 40 },
    });
    for (let tick = 0; tick < 8; tick++)
      await processPendingBrowserArchiveAuditJobs(bindings, 500 + tick * 10);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1000);
    expect(finished).toMatchObject({ status: 'finished', complete: false });
    expect(finished?.progress).toMatchObject({ segments_checked: 2, archive_facts_checked: 41 });
    expect(finished?.observed_comparison_counts).toMatchObject({
      matched: 1,
      archive_only_facts: 40,
      duplicate_archive_candidates: 0,
    });
  });

  it('stops when the verified segment bytes change during a partial resume', async () => {
    const batches = Array.from({ length: 40 }, (_, index) => ({
      ...batch,
      batch_id: `changed-${index}`,
    }));
    let changed = false;
    const bindings = {
      db,
      archive,
      history: {
        get: async () =>
          archiveBody(
            changed
              ? batches.map((value) => ({
                  ...value,
                  events: value.events.map((event) => ({ ...event, path: '/changed' })),
                }))
              : batches,
          ),
      },
    };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 200);
    changed = true;
    await processPendingBrowserArchiveAuditJobs(bindings, 300);
    const stopped = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 301);
    expect(stopped).toMatchObject({
      status: 'incomplete',
      progress: { receipts_processed: 0, segments_checked: 0, archive_facts_checked: 39 },
    });
    expect(stopped?.incomplete_reasons).toContain('archive_segment_snapshot_changed');
    const repeated = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 400);
    expect(repeated).toMatchObject({ job_id: started.job_id, status: 'incomplete' });
    expect(repeated.incomplete_reasons).toContain('archive_segment_snapshot_changed');
  });

  it('resumes the committed offset after a lost database acknowledgement without duplicate counts', async () => {
    const batches = Array.from({ length: 40 }, (_, index) => ({
      ...batch,
      batch_id: index === 0 ? batch.batch_id : `lost-ack-${index}`,
    }));
    let loseAcknowledgement = true;
    const interruptedDb = {
      prepare: db.prepare.bind(db),
      async batch(statements: Parameters<typeof db.batch>[0]) {
        const results = await db.batch<Record<string, unknown>>(statements);
        if (loseAcknowledgement && results.some((result) => result.meta.changes > 0)) {
          loseAcknowledgement = false;
          throw new Error('lost database acknowledgement');
        }
        return results;
      },
    };
    const history = { get: async () => archiveBody(batches) };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await expect(
      processBrowserArchiveAuditJob(
        { db: interruptedDb, archive, history },
        WORKSPACE,
        started.job_id,
        200,
      ),
    ).rejects.toThrow('lost database acknowledgement');
    const committed = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 201);
    expect(committed?.progress).toMatchObject({ archive_facts_checked: 39, receipts_processed: 0 });
    for (let tick = 0; tick < 8; tick++)
      await processPendingBrowserArchiveAuditJobs({ db, archive, history }, 300 + tick * 10);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1000);
    expect(finished).toMatchObject({ status: 'finished', complete: false });
    expect(finished?.progress).toMatchObject({ archive_facts_checked: 40, receipts_processed: 1 });
    expect(finished?.observed_comparison_counts).toMatchObject({
      matched: 1,
      archive_only_facts: 39,
      duplicate_archive_candidates: 0,
    });
  });

  it('resumes only fact-capped jobs through the existing owner start operation and preserves progress', async () => {
    const batches = Array.from({ length: 40 }, (_, index) => ({
      ...batch,
      batch_id: `restart-cap-${index}`,
    }));
    const bindings = { db, archive, history: { get: async () => archiveBody(batches) } };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await processBrowserArchiveAuditJob(bindings, WORKSPACE, started.job_id, 200);
    await db
      .prepare(
        `UPDATE browser_archive_audit_jobs SET status = 'incomplete', phase = 'done',
      incomplete_reasons_json = '["audit_fact_slice_cap"]' WHERE job_id = ?`,
      )
      .bind(started.job_id)
      .run();
    const other = await startBrowserArchiveAuditJob(db, 'workspace-other', DAY, 250);
    await expect(startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 260)).rejects.toThrow(
      'audit already running',
    );
    await db
      .prepare("UPDATE browser_archive_audit_jobs SET status = 'finished' WHERE job_id = ?")
      .bind(other.job_id)
      .run();
    const resumed = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 300);
    expect(resumed).toMatchObject({
      job_id: started.job_id,
      status: 'running',
      phase: 'receipts',
      progress: { archive_facts_checked: 39, receipts_processed: 0 },
    });
    expect(resumed.incomplete_reasons).not.toContain('audit_fact_slice_cap');
    for (let tick = 0; tick < 8; tick++)
      await processPendingBrowserArchiveAuditJobs(bindings, 400 + tick * 10);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1000);
    expect(finished?.progress.archive_facts_checked).toBe(40);
    expect(finished?.observed_comparison_counts.duplicate_archive_candidates).toBe(0);
  });

  it('advances bounded scheduled slices and reports aggregate-only incomplete evidence', async () => {
    await db
      .prepare(
        `INSERT INTO browser_queue_stage_receipts
         (workspace_id, app_id, environment_id, batch_id, staged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(WORKSPACE, batch.app_id, batch.environment_id, batch.batch_id, 150, 35_000_000_000)
      .run();
    const bindings = { db, archive, history };
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    expect(started.status).toBe('queued');
    expect(started.complete).toBe(false);

    const repeated = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 101);
    expect(repeated.job_id).toBe(started.job_id);

    await processPendingBrowserArchiveAuditJobs(bindings, 200);
    const afterFirstTick = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 201);
    expect(afterFirstTick?.progress.receipts_processed).toBe(1);
    expect(afterFirstTick?.status).toBe('running');

    for (let tick = 0; tick < 4; tick++)
      await processPendingBrowserArchiveAuditJobs(bindings, 300 + tick * 10);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1_000);
    expect(finished).toMatchObject({ status: 'finished', complete: false, day: DAY });
    expect(finished?.observed_comparison_counts).toMatchObject({
      matched: 1,
      queue_stage_receipts: 1,
      queue_stage_unobserved: 0,
    });
    expect(finished?.incomplete_reasons).toContain('queue_evidence_unavailable');
    expect(finished?.incomplete_reasons).toContain('dlq_evidence_unavailable');
    expect(finished?.incomplete_reasons).toContain('batch_index_returns_one_candidate');

    const keys = Object.keys(finished ?? {}).sort();
    expect(keys).toEqual([
      'complete',
      'created_at',
      'day',
      'expires_at',
      'incomplete_reasons',
      'job_id',
      'observed_comparison_counts',
      'phase',
      'progress',
      'status',
      'updated_at',
    ]);
    expect(JSON.stringify(finished)).not.toContain(batch.app_id);
    expect(JSON.stringify(finished)).not.toContain(batch.batch_id);
    expect(JSON.stringify(finished)).not.toContain(batch.visitor_hash);
    expect(JSON.stringify(finished)).not.toContain('/private-path');
    const persisted = await db
      .prepare('SELECT * FROM browser_archive_audit_facts WHERE job_id = ?')
      .bind(started.job_id)
      .all();
    expect(JSON.stringify(persisted.results)).not.toContain(batch.batch_id);
    expect(JSON.stringify(persisted.results)).not.toContain(batch.visitor_hash);
  });

  it('reports a staged batch with no archived fact without certifying completeness', async () => {
    const missingArchive = {
      getByName(_name: string) {
        return {
          archiveSegmentForBatch: async () => null,
          archiveSegmentsForEventDay: async (_day: string) => ({
            segments: [],
            next_cursor: null,
            snapshot_sequence: 1,
          }),
        };
      },
    };
    await db
      .prepare(
        `INSERT INTO browser_queue_stage_receipts
         (workspace_id, app_id, environment_id, batch_id, staged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(WORKSPACE, batch.app_id, batch.environment_id, batch.batch_id, 150, 35_000_000_000)
      .run();
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    for (let tick = 0; tick < 5; tick++)
      await processPendingBrowserArchiveAuditJobs(
        { db, archive: missingArchive, history },
        200 + tick * 100,
      );
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1_000);
    expect(finished).toMatchObject({
      status: 'finished',
      complete: false,
      observed_comparison_counts: {
        no_archive_candidate: 1,
        queue_stage_receipts: 1,
        queue_stage_unobserved: 0,
      },
    });
    expect(finished?.incomplete_reasons).toContain('queue_evidence_unavailable');
  });

  it('reports absent stage evidence as unobserved even when archive facts match', async () => {
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    for (let tick = 0; tick < 5; tick++)
      await processPendingBrowserArchiveAuditJobs({ db, archive, history }, 200 + tick * 100);
    const finished = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 1_000);
    expect(finished).toMatchObject({
      status: 'finished',
      complete: false,
      observed_comparison_counts: {
        matched: 1,
        queue_stage_receipts: 0,
        queue_stage_unobserved: 1,
      },
    });
    expect(finished?.incomplete_reasons).toContain('queue_stage_receipt_unobserved');
  });

  it('does not count an expired stage receipt when retention cleanup is behind', async () => {
    await db
      .prepare(
        `INSERT INTO browser_queue_stage_receipts
         (workspace_id, app_id, environment_id, batch_id, staged_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(WORKSPACE, batch.app_id, batch.environment_id, batch.batch_id, 150, 199)
      .run();
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 200);
    const current = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 201);
    expect(current?.observed_comparison_counts).toMatchObject({
      queue_stage_receipts: 0,
      queue_stage_unobserved: 1,
    });
    expect(current?.complete).toBe(false);
  });

  it('requires a full workspace owner and hides jobs from another workspace', async () => {
    const env = {
      DB: db,
      BROWSER_ARCHIVE: { getByName: (name: string) => archive.getByName(name) },
      BROWSER_HISTORY: history,
    } as unknown as BrowserEnvironment;
    const denied = await handleBrowserOwner(
      new Request(`https://health.test/v1/browser/archive-audits?day=${DAY}`, { method: 'POST' }),
      env,
      { id: 'scoped', label: 'Scoped', workspaceId: WORKSPACE, appId: batch.app_id },
      false,
    );
    expect(denied?.status).toBe(403);

    const created = await handleBrowserOwner(
      new Request(`https://health.test/v1/browser/archive-audits?day=${DAY}`, { method: 'POST' }),
      env,
      { id: 'owner', label: 'Owner', workspaceId: WORKSPACE },
      false,
    );
    expect(created?.status).toBe(202);
    const body = (await created!.json()) as { job_id: string; complete: boolean };
    expect(body.complete).toBe(false);

    const hidden = await readBrowserArchiveAuditJob(db, 'other-workspace', body.job_id, Date.now());
    expect(hidden).toBeNull();
    const invalid = await handleBrowserOwner(
      new Request('https://health.test/v1/browser/archive-audits?day=2026-02-30', {
        method: 'POST',
      }),
      env,
      { id: 'owner', label: 'Owner', workspaceId: WORKSPACE },
      false,
    );
    expect(invalid?.status).toBe(400);
  });

  it('restricts visitor proof writes to same-origin full workspace owners and strict fields', async () => {
    const env = { DB: db } as unknown as BrowserEnvironment;
    const path = 'https://health.test/v1/browser/visitor-coverage';
    const body = JSON.stringify({ action: 'rollout-start', generation_id: 'g', extra: 'no' });
    const scoped = await handleBrowserOwner(
      new Request(path, { method: 'POST', headers: { origin: 'https://health.test' }, body }),
      env,
      { id: 'scoped', label: 'Scoped', workspaceId: WORKSPACE, appId: batch.app_id },
      false,
    );
    expect(scoped?.status).toBe(403);

    const crossOrigin = await handleBrowserOwner(
      new Request(path, { method: 'POST', headers: { origin: 'https://attacker.test' }, body }),
      env,
      { id: 'owner', label: 'Owner', workspaceId: WORKSPACE },
      false,
    );
    expect(crossOrigin?.status).toBe(403);

    const extra = await handleBrowserOwner(
      new Request(path, { method: 'POST', headers: { origin: 'https://health.test' }, body }),
      env,
      { id: 'owner', label: 'Owner', workspaceId: WORKSPACE },
      false,
    );
    expect(extra?.status).toBe(400);
  });

  it('stops incomplete when a resumed shard cursor observes a changed snapshot', async () => {
    await db.prepare('DELETE FROM browser_visitor_days').run();
    await db.prepare('DELETE FROM browser_visitor_receipt_days').run();
    await db.prepare('DELETE FROM browser_visitor_batch_receipts').run();
    forceSnapshotChange = true;
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 2_000);
    await processPendingBrowserArchiveAuditJobs({ db, archive, history }, 2_100);
    const state = await readBrowserArchiveAuditJob(db, WORKSPACE, started.job_id, 2_200);
    expect(state).toMatchObject({ status: 'incomplete', complete: false });
    expect(state?.incomplete_reasons).toContain('archive_index_snapshot_changed');
    expect(shardZeroPageCalls).toBe(2);
  });

  it('restarts an expired same-day job without waiting for scheduled cleanup', async () => {
    const old = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await db
      .prepare(
        `INSERT INTO browser_archive_audit_facts
         (job_id, identity_hash, has_receipt, receipt_digest_version, receipt_digest)
         VALUES (?, ?, 1, 1, ?)`,
      )
      .bind(old.job_id, 'a'.repeat(64), 'b'.repeat(64))
      .run();

    const restarted = await startBrowserArchiveAuditJob(
      db,
      WORKSPACE,
      DAY,
      100 + 14 * 24 * 60 * 60 * 1000,
    );
    expect(restarted.job_id).not.toBe(old.job_id);
    expect(restarted.status).toBe('queued');
    const oldFacts = await db
      .prepare('SELECT COUNT(*) AS count FROM browser_archive_audit_facts WHERE job_id = ?')
      .bind(old.job_id)
      .first<{ count: number }>();
    expect(oldFacts?.count).toBe(0);
  });

  it('serializes overlapping slice deliveries with a D1 lease', async () => {
    const started = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 5_000);
    const results = await Promise.allSettled([
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_100),
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_100),
    ]);
    expect(batchLookupCalls).toBe(1);
    expect(
      results.map((result) => (result.status === 'rejected' ? String(result.reason) : 'fulfilled')),
    ).toEqual(['fulfilled', 'fulfilled']);
    const job = await db
      .prepare(
        'SELECT receipt_cursor, receipts_processed, lease_token FROM browser_archive_audit_jobs WHERE job_id = ?',
      )
      .bind(started.job_id)
      .first<{ receipt_cursor: number; receipts_processed: number; lease_token: string | null }>();
    const facts = await db
      .prepare('SELECT archive_count FROM browser_archive_audit_facts WHERE job_id = ?')
      .bind(started.job_id)
      .all<{ archive_count: number }>();
    expect(job?.receipt_cursor).toBeGreaterThan(0);
    expect(job?.receipts_processed).toBe(1);
    expect(job?.lease_token).toBeNull();
    expect(facts.results.map((fact) => fact.archive_count)).toEqual([1]);

    await Promise.all([
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_200),
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_200),
    ]);
    await Promise.all([
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_300),
      processBrowserArchiveAuditJob({ db, archive, history }, WORKSPACE, started.job_id, 5_300),
    ]);
    const indexJob = await db
      .prepare(
        'SELECT shard_state_json, segment_count, archive_fact_count FROM browser_archive_audit_jobs WHERE job_id = ?',
      )
      .bind(started.job_id)
      .first<{ shard_state_json: string; segment_count: number; archive_fact_count: number }>();
    expect(dayPageCalls).toBe(4);
    expect(indexJob?.segment_count).toBe(1);
    expect(indexJob?.archive_fact_count).toBe(1);
  });

  it('admits one globally active job and starts another workspace after completion', async () => {
    const first = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 10_000);
    await expect(
      startBrowserArchiveAuditJob(db, 'workspace-b', '2026-09-28', 10_001),
    ).rejects.toThrow('audit already running');

    for (let tick = 0; tick < 5; tick++)
      await processPendingBrowserArchiveAuditJobs({ db, archive, history }, 10_100 + tick * 100);
    const completed = await readBrowserArchiveAuditJob(db, WORKSPACE, first.job_id, 10_700);
    expect(completed?.status).toBe('finished');
    expect(
      await startBrowserArchiveAuditJob(db, 'workspace-b', '2026-09-28', 10_800),
    ).toMatchObject({ status: 'queued', complete: false });
  });

  it('retires an expired active job globally before another workspace is admitted', async () => {
    const first = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 200);
    const afterExpiry = 200 + 14 * 24 * 60 * 60 * 1000;
    const next = await startBrowserArchiveAuditJob(db, 'workspace-b', '2026-09-28', afterExpiry);
    expect(next).toMatchObject({ status: 'queued', complete: false });
    const expired = await db
      .prepare('SELECT status, lease_token FROM browser_archive_audit_jobs WHERE job_id = ?')
      .bind(first.job_id)
      .first<{ status: string; lease_token: string | null }>();
    expect(expired).toEqual({ status: 'incomplete', lease_token: null });
  });

  it('physically cleans expired pseudonymous state using D1 alone', async () => {
    const old = await startBrowserArchiveAuditJob(db, WORKSPACE, DAY, 100);
    await db
      .prepare(
        `INSERT INTO browser_archive_audit_facts (job_id, identity_hash)
         VALUES (?, ?)`,
      )
      .bind(old.job_id, 'c'.repeat(64))
      .run();
    await db
      .prepare('INSERT INTO browser_archive_audit_segments (job_id, segment_hash) VALUES (?, ?)')
      .bind(old.job_id, 'd'.repeat(64))
      .run();

    const activeExpiry = 100 + 14 * 24 * 60 * 60 * 1000;
    await cleanupExpiredBrowserArchiveAuditJobs(db, activeExpiry);
    const expiredState = await db
      .prepare(
        'SELECT status, incomplete_reasons_json FROM browser_archive_audit_jobs WHERE job_id = ?',
      )
      .bind(old.job_id)
      .first<{ status: string; incomplete_reasons_json: string }>();
    expect(expiredState).toEqual({
      status: 'incomplete',
      incomplete_reasons_json: '["audit_job_expired"]',
    });

    await cleanupExpiredBrowserArchiveAuditJobs(db, activeExpiry + 24 * 60 * 60 * 1000);

    for (const table of [
      'browser_archive_audit_facts',
      'browser_archive_audit_segments',
      'browser_archive_audit_jobs',
    ]) {
      const result = await db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE job_id = ?`)
        .bind(old.job_id)
        .first<{ count: number }>();
      expect(result?.count).toBe(0);
    }
  });
});
