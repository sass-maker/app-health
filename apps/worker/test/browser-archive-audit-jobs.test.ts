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

async function archiveBody() {
  const archived = {
    ...batch,
    facts_digest_version: 1,
    facts_digest: await digestBrowserEventFacts(batch),
  };
  const raw = Buffer.from(`${JSON.stringify(archived)}\n`);
  const compressed = gzipSync(raw);
  const manifest = {
    schema_version: 1,
    object_key: OBJECT_KEY,
    workspace_id: WORKSPACE,
    format: 'jsonl-gzip',
    content_sha256: createHash('sha256').update(compressed).digest('hex'),
    row_count: 1,
    event_count: 1,
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
const archive = {
  getByName(name: string) {
    const shard = Number(name.split(':').at(-1));
    return {
      archiveSegmentForBatch: async () => REFERENCE,
      archiveSegmentsForEventDay: async (day: string) => {
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
  body = await archiveBody();
});

beforeEach(async () => {
  forceSnapshotChange = false;
  shardZeroPageCalls = 0;
  await db.prepare('DELETE FROM browser_archive_audit_jobs').run();
  await db.prepare('DELETE FROM browser_visitor_days').run();
  await db.prepare('DELETE FROM browser_visitor_receipt_days').run();
  await db.prepare('DELETE FROM browser_visitor_batch_receipts').run();
  await db.prepare('DELETE FROM browser_visitor_rollup_meta').run();
  await acceptBrowserVisitorBatch(db, batch, batch.received_at);
});

afterAll(() => mf.dispose());

describe('resumable browser archive audit jobs', () => {
  it('advances bounded scheduled slices and reports aggregate-only incomplete evidence', async () => {
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
    expect(finished?.observed_comparison_counts).toMatchObject({ matched: 1 });
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
});
