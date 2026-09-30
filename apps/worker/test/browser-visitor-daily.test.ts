import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import type { BrowserEnvironment } from '../src/browser-routes.js';
import { acceptBrowser } from '../src/browser-routes.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import type { AppHealthRepositories } from '../src/repository.js';
import { recordBrowserQueueStageReceipts } from '../src/browser-queue.js';
import {
  acceptBrowserVisitorBatch,
  confirmBrowserVisitorRolloutFullTraffic,
  deactivateBrowserVisitorScope,
  recordBrowserVisitorCoverageAudit,
  readBrowserVisitorReceiptPage,
  recordBrowserVisitorRolloutStart,
  recordBrowserVisitorScopeActivation,
  sealExactBrowserVisitorDay,
  BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS,
  BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
  BROWSER_VISITOR_RETENTION_DAYS,
  MAX_BROWSER_VISITOR_RECEIPT_PAGE_SIZE,
  MAX_EXACT_BROWSER_VISITOR_SCOPES,
  browserVisitorDayIsComplete,
  cleanupBrowserVisitorDays,
  indiaDayForTimestamp,
  readExactBrowserVisitorDays,
} from '../src/browser-visitor-daily.js';

const BROWSER_VISITOR_DAY_MS = 86_400_000;
const BROWSER_VISITOR_MAX_LATENESS_MS = BROWSER_VISITOR_DAY_MS;
const WORKER_SHA = 'c'.repeat(40);
const TRACKER_SHA = 'd'.repeat(40);
const AUDIT_SHA = 'e'.repeat(64);

const mf = new Miniflare({
  modules: true,
  script: 'export default { fetch() { return new Response("ok"); } }',
  compatibilityDate: '2026-07-22',
  d1Databases: ['DB'],
  cf: false,
});
const firstApp = { workspace: 'workspace-a', app_id: 'app-a', environment_id: 'prod-a' };
const otherEnvironment = { ...firstApp, environment_id: 'stage-a' };
const otherApp = { ...firstApp, app_id: 'app-b', environment_id: 'prod-b' };
const VISITOR_A = 'a'.repeat(64);
const VISITOR_B = 'b'.repeat(64);
const toMs = (value: string) => Date.parse(value);
let db: Awaited<ReturnType<typeof mf.getD1Database>>;

function batch(overrides: Partial<CollectedBrowserBatch> = {}): CollectedBrowserBatch {
  return {
    ...firstApp,
    batch_id: crypto.randomUUID(),
    received_at: toMs('2026-09-30T00:00:00Z'),
    visitor_hash: VISITOR_A,
    events: [
      {
        event_id: crypto.randomUUID(),
        timestamp: toMs('2026-09-29T19:00:00Z'),
        type: 'pageview',
        path: '/',
        referrer: '',
      },
    ],
    ...overrides,
  };
}

async function attestRollout(
  workspace: string,
  generation: string,
  cutoverAt: number,
  options: { sha?: string; version?: string } = {},
) {
  const sha = options.sha ?? WORKER_SHA;
  const version = options.version ?? `version-${generation}`;
  await recordBrowserVisitorRolloutStart(db, {
    workspace_id: workspace,
    generation_id: generation,
    worker_version_id: version,
    source_sha: sha,
    rollout_started_at: cutoverAt - 1_000,
    rollout_observed_at: cutoverAt - 500,
    rollout_traffic_percent: 0,
  });
  await confirmBrowserVisitorRolloutFullTraffic(db, {
    workspace_id: workspace,
    generation_id: generation,
    worker_version_id: version,
    source_sha: sha,
    full_traffic_at: cutoverAt,
    observed_at: cutoverAt + 500,
    traffic_percent: 100,
  });
}

async function activateScope(
  scope: typeof firstApp | typeof otherApp,
  activatedAt: number,
  verifiedAt = activatedAt,
) {
  await recordBrowserVisitorScopeActivation(db, {
    workspace_id: scope.workspace,
    app_id: scope.app_id,
    environment_id: scope.environment_id,
    activated_at: activatedAt,
    verified_at: verifiedAt,
    tracker_source_sha: TRACKER_SHA,
  });
}

async function auditAndSeal(
  scope: typeof firstApp | typeof otherApp,
  day: string,
  now: number,
  ids = `${scope.app_id}-${day}`,
) {
  const closeAt =
    toMs(`${day}T18:30:00Z`) +
    BROWSER_VISITOR_MAX_LATENESS_MS +
    BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
  await recordBrowserVisitorCoverageAudit(db, {
    workspace_id: scope.workspace,
    audit_id: `worker-${ids}`,
    audit_kind: 'worker_rollouts',
    audited_through: closeAt,
    observed_at: now,
    evidence_sha: AUDIT_SHA,
  });
  await recordBrowserVisitorCoverageAudit(db, {
    workspace_id: scope.workspace,
    audit_id: `scope-${ids}`,
    audit_kind: 'tracker_scope',
    app_id: scope.app_id,
    environment_id: scope.environment_id,
    audited_through: closeAt,
    observed_at: now,
    evidence_sha: AUDIT_SHA,
  });
  return sealExactBrowserVisitorDay(db, {
    workspace_id: scope.workspace,
    app_id: scope.app_id,
    environment_id: scope.environment_id,
    day,
    now,
  });
}

async function apply(sql: string) {
  for (const statement of sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((part) => part.trim()))
    await db.prepare(statement).run();
}

beforeAll(async () => {
  db = await mf.getD1Database('DB');
  await db
    .prepare(
      'CREATE TABLE environments (id TEXT NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (id, app_id))',
    )
    .run();
  await db
    .prepare('CREATE TABLE workspace_apps (app_id TEXT NOT NULL, workspace_id TEXT NOT NULL)')
    .run();
  await db.batch([
    db
      .prepare('INSERT INTO environments (id, app_id, name) VALUES (?, ?, ?)')
      .bind('prod-a', 'app-a', 'production'),
    db
      .prepare('INSERT INTO environments (id, app_id, name) VALUES (?, ?, ?)')
      .bind('stage-a', 'app-a', 'staging'),
    db
      .prepare('INSERT INTO environments (id, app_id, name) VALUES (?, ?, ?)')
      .bind('prod-b', 'app-b', 'production'),
  ]);
  await db.batch([
    db
      .prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
      .bind('app-a', 'workspace-a'),
    db
      .prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
      .bind('app-b', 'workspace-a'),
    db
      .prepare('INSERT INTO workspace_apps (app_id, workspace_id) VALUES (?, ?)')
      .bind('app-a', 'workspace-cutover'),
  ]);
  await apply(
    await readFile(new URL('../migrations/0019_browser_visitor_days.sql', import.meta.url), 'utf8'),
  );
  await apply(
    await readFile(
      new URL('../migrations/0020_browser_receipt_reconciliation.sql', import.meta.url),
      'utf8',
    ),
  );
  await apply(
    await readFile(
      new URL('../migrations/0021_browser_event_facts_digest.sql', import.meta.url),
      'utf8',
    ),
  );
  await apply(
    await readFile(
      new URL('../migrations/0023_browser_queue_stage_receipts.sql', import.meta.url),
      'utf8',
    ),
  );
  await apply(
    await readFile(
      new URL('../migrations/0025_browser_visitor_acceptance_coverage.sql', import.meta.url),
      'utf8',
    ),
  );
  await apply(
    await readFile(
      new URL('../migrations/0026_browser_visitor_day_seals.sql', import.meta.url),
      'utf8',
    ),
  );
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM browser_visitor_days'),
    db.prepare('DELETE FROM browser_visitor_receipt_days'),
    db.prepare('DELETE FROM browser_visitor_batch_receipts'),
    db.prepare('DELETE FROM browser_queue_stage_receipts'),
    db.prepare('DELETE FROM browser_visitor_scope_activations'),
    db.prepare('DELETE FROM browser_visitor_acceptance_rollouts'),
    db.prepare('DELETE FROM browser_visitor_acceptance_day_fences'),
    db.prepare('DELETE FROM browser_visitor_coverage_audits'),
    db.prepare('DELETE FROM browser_visitor_rollup_meta'),
  ]);
});

afterAll(() => mf.dispose());

describe('exact browser visitor daily ledger', () => {
  it('does not rewrite an existing visitor unless its expiry needs extending', async () => {
    await db.prepare('CREATE TABLE visitor_update_audit (count INTEGER NOT NULL)').run();
    await db.prepare('INSERT INTO visitor_update_audit VALUES (0)').run();
    await db
      .prepare(
        `CREATE TRIGGER audit_visitor_updates AFTER UPDATE ON browser_visitor_days
      BEGIN UPDATE visitor_update_audit SET count = count + 1; END`,
      )
      .run();
    try {
      const first = batch();
      await acceptBrowserVisitorBatch(db, first, first.received_at);
      const original = await db.prepare('SELECT expires_at FROM browser_visitor_days').first();
      await acceptBrowserVisitorBatch(db, first, first.received_at + 1);
      await acceptBrowserVisitorBatch(db, batch(), first.received_at + 2);
      expect(await db.prepare('SELECT count FROM visitor_update_audit').first()).toEqual({
        count: 0,
      });
      expect(await db.prepare('SELECT expires_at FROM browser_visitor_days').first()).toEqual(
        original,
      );
      expect(
        await db.prepare('SELECT COUNT(*) AS count FROM browser_visitor_days').first(),
      ).toEqual({ count: 1 });

      await db.prepare('UPDATE browser_visitor_days SET expires_at = expires_at - 1').run();
      await db.prepare('UPDATE visitor_update_audit SET count = 0').run();
      await acceptBrowserVisitorBatch(db, batch(), first.received_at + 3);
      expect(await db.prepare('SELECT count FROM visitor_update_audit').first()).toEqual({
        count: 1,
      });
      expect(await db.prepare('SELECT expires_at FROM browser_visitor_days').first()).toEqual(
        original,
      );
    } finally {
      await db.prepare('DROP TRIGGER audit_visitor_updates').run();
      await db.prepare('DROP TABLE visitor_update_audit').run();
    }
  });

  it('deduplicates a scoped visitor on an India day and keeps app/environment scopes separate', async () => {
    const first = batch();
    await acceptBrowserVisitorBatch(db, first, first.received_at);
    await acceptBrowserVisitorBatch(db, first, first.received_at + 1);
    await acceptBrowserVisitorBatch(
      db,
      batch({ ...otherEnvironment, visitor_hash: VISITOR_A, batch_id: crypto.randomUUID() }),
      first.received_at,
    );
    await acceptBrowserVisitorBatch(
      db,
      batch({ ...otherApp, visitor_hash: VISITOR_A, batch_id: crypto.randomUUID() }),
      first.received_at,
    );
    await acceptBrowserVisitorBatch(
      db,
      batch({ visitor_hash: VISITOR_B, batch_id: crypto.randomUUID() }),
      first.received_at,
    );

    const rows = await db
      .prepare(
        `SELECT app_id, environment_id, india_day, COUNT(*) AS visitors
         FROM browser_visitor_days GROUP BY app_id, environment_id, india_day
         ORDER BY app_id, environment_id`,
      )
      .all();
    expect(rows.results).toEqual([
      { app_id: 'app-a', environment_id: 'prod-a', india_day: '2026-09-30', visitors: 2 },
      { app_id: 'app-a', environment_id: 'stage-a', india_day: '2026-09-30', visitors: 1 },
      { app_id: 'app-b', environment_id: 'prod-b', india_day: '2026-09-30', visitors: 1 },
    ]);
  });

  it('assigns half-open Asia/Kolkata midnight correctly and repairs late-arriving event days', async () => {
    expect(indiaDayForTimestamp(toMs('2026-09-28T18:29:59.999Z'))).toBe('2026-09-28');
    expect(indiaDayForTimestamp(toMs('2026-09-28T18:30:00.000Z'))).toBe('2026-09-29');
    const late = batch({
      received_at: toMs('2026-09-30T00:00:00Z'),
      events: [
        {
          event_id: crypto.randomUUID(),
          timestamp: toMs('2026-09-29T00:00:00Z'),
          type: 'pageview',
          path: '/late',
          referrer: '',
        },
      ],
    });
    await acceptBrowserVisitorBatch(db, late, late.received_at);
    const row = await db
      .prepare('SELECT india_day FROM browser_visitor_days WHERE app_id = ?')
      .bind('app-a')
      .first<{ india_day: string }>();
    expect(row?.india_day).toBe('2026-09-29');
  });

  it('records receipt time, event count and every India event day idempotently across retries', async () => {
    const receivedAt = toMs('2026-09-30T00:00:00Z');
    const item = batch({
      batch_id: 'multi-day-batch',
      received_at: receivedAt,
      events: [
        {
          event_id: 'first-event',
          timestamp: toMs('2026-09-29T18:29:59.999Z'),
          type: 'pageview',
          path: '/before-midnight',
          referrer: '',
        },
        {
          event_id: 'second-event',
          timestamp: toMs('2026-09-29T18:30:00.000Z'),
          type: 'pageview',
          path: '/after-midnight',
          referrer: '',
        },
      ],
    });
    await acceptBrowserVisitorBatch(db, item, receivedAt);
    await acceptBrowserVisitorBatch(db, item, receivedAt + 10_000);

    expect(
      await db
        .prepare(
          `SELECT batch_id, accepted_at, event_count, fingerprint, facts_digest_version, facts_digest
           FROM browser_visitor_batch_receipts WHERE batch_id = ?`,
        )
        .bind(item.batch_id)
        .all(),
    ).toMatchObject({
      results: [
        {
          batch_id: item.batch_id,
          accepted_at: receivedAt,
          event_count: 2,
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          facts_digest_version: 1,
          facts_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(
      await db
        .prepare(
          'SELECT india_day FROM browser_visitor_receipt_days WHERE batch_id = ? ORDER BY india_day',
        )
        .bind(item.batch_id)
        .all(),
    ).toMatchObject({ results: [{ india_day: '2026-09-29' }, { india_day: '2026-09-30' }] });
  });

  it('leaves legacy 0019 receipts unindexed when retried with the same fingerprint', async () => {
    const item = batch({ batch_id: 'legacy-0019-batch' });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    await db.batch([
      db
        .prepare(
          `UPDATE browser_visitor_batch_receipts
           SET accepted_at = NULL, event_count = NULL, facts_digest_version = NULL, facts_digest = NULL
           WHERE batch_id = ?`,
        )
        .bind(item.batch_id),
      db.prepare('DELETE FROM browser_visitor_receipt_days WHERE batch_id = ?').bind(item.batch_id),
      db
        .prepare(
          `DELETE FROM browser_visitor_days
           WHERE app_id = ? AND environment_id = ? AND visitor_hash = ?`,
        )
        .bind(item.app_id, item.environment_id, item.visitor_hash),
    ]);

    await acceptBrowserVisitorBatch(db, item, item.received_at + 10_000);

    expect(
      await db
        .prepare(
          'SELECT accepted_at, event_count, facts_digest_version, facts_digest FROM browser_visitor_batch_receipts WHERE batch_id = ?',
        )
        .bind(item.batch_id)
        .first(),
    ).toEqual({
      accepted_at: null,
      event_count: null,
      facts_digest_version: null,
      facts_digest: null,
    });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_receipt_days WHERE batch_id = ?')
        .bind(item.batch_id)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_days WHERE app_id = ?')
        .bind(item.app_id)
        .first(),
    ).toEqual({ n: 0 });
  });

  it('accepts matching 0020 retries without promoting their null digest to verified', async () => {
    const item = batch({ batch_id: 'legacy-0020-batch' });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    await db
      .prepare(
        'UPDATE browser_visitor_batch_receipts SET facts_digest_version = NULL, facts_digest = NULL WHERE batch_id = ?',
      )
      .bind(item.batch_id)
      .run();

    await expect(
      acceptBrowserVisitorBatch(db, item, item.received_at + 10_000),
    ).resolves.toBeUndefined();
    expect(
      await db
        .prepare(
          'SELECT accepted_at, event_count, facts_digest_version, facts_digest FROM browser_visitor_batch_receipts WHERE batch_id = ?',
        )
        .bind(item.batch_id)
        .first(),
    ).toMatchObject({
      accepted_at: item.received_at,
      event_count: item.events.length,
      facts_digest_version: null,
      facts_digest: null,
    });
  });

  it('rejects changed event facts when a batch id keeps the same count and India day', async () => {
    const item = batch({ batch_id: 'same-count-day' });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    const changed = {
      ...item,
      events: [{ ...item.events[0]!, path: '/different-path' }],
    };
    await expect(acceptBrowserVisitorBatch(db, changed, changed.received_at)).rejects.toThrow(
      'Browser batch identity reused with different facts',
    );
  });

  it('binds the scoped visitor hash, including its absent state, into the canonical digest', async () => {
    const item = batch({ batch_id: 'visitor-digest-binding' });
    const originalDigest = await digestBrowserEventFacts(item);
    const changedHashDigest = await digestBrowserEventFacts({ ...item, visitor_hash: VISITOR_B });
    const missingHashDigest = await digestBrowserEventFacts({ ...item, visitor_hash: undefined });
    const uppercaseHashDigest = await digestBrowserEventFacts({
      ...item,
      visitor_hash: VISITOR_A.toUpperCase(),
    });

    expect(changedHashDigest).not.toBe(originalDigest);
    expect(missingHashDigest).not.toBe(originalDigest);
    expect(uppercaseHashDigest).toBe(originalDigest);
    expect(originalDigest).not.toContain(VISITOR_A);
  });

  it('stores only a versioned digest of event facts in D1 and leaves historical rows unverified', async () => {
    const item = batch({ batch_id: 'privacy-digest' });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    const legacy = batch({ batch_id: 'legacy-null-digest' });
    await acceptBrowserVisitorBatch(db, legacy, legacy.received_at);
    await db
      .prepare(
        'UPDATE browser_visitor_batch_receipts SET facts_digest_version = NULL, facts_digest = NULL WHERE batch_id = ?',
      )
      .bind(legacy.batch_id)
      .run();
    const rows = await db
      .prepare(
        'SELECT facts_digest_version, facts_digest FROM browser_visitor_batch_receipts ORDER BY batch_id',
      )
      .all<{ facts_digest_version: number | null; facts_digest: string | null }>();
    expect(rows.results).toEqual([
      { facts_digest_version: null, facts_digest: null },
      { facts_digest_version: 1, facts_digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(JSON.stringify(rows.results)).not.toContain(item.events[0]!.path);
  });

  it('indexes accepted batches without a visitor hash and rejects changed event counts on retry', async () => {
    const item = batch({ batch_id: 'hashless-batch', visitor_hash: undefined });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    expect(
      await db
        .prepare('SELECT event_count FROM browser_visitor_batch_receipts WHERE batch_id = ?')
        .bind(item.batch_id)
        .first(),
    ).toEqual({ event_count: 1 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_receipt_days WHERE batch_id = ?')
        .bind(item.batch_id)
        .first(),
    ).toEqual({ n: 1 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_days WHERE app_id = ?')
        .bind(item.app_id)
        .first(),
    ).toEqual({ n: 0 });

    const changed = batch({ ...item, events: [...item.events, ...item.events] });
    await expect(acceptBrowserVisitorBatch(db, changed, changed.received_at)).rejects.toThrow(
      'Browser batch identity reused with different facts',
    );
  });

  it('returns bounded, stable per-day receipt pages without exposing visitor hashes', async () => {
    const day = '2026-09-30';
    for (const batchId of ['receipt-c', 'receipt-a', 'receipt-b']) {
      const item = batch({ batch_id: batchId });
      await acceptBrowserVisitorBatch(db, item, item.received_at);
    }
    const first = await readBrowserVisitorReceiptPage(db, firstApp.workspace, [firstApp], day, 2);
    expect(first.receipts.map((receipt) => receipt.batch_id)).toEqual(['receipt-a', 'receipt-b']);
    expect(first.next_cursor).toEqual({
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      batch_id: 'receipt-b',
    });
    expect(first.receipts[0]).toMatchObject({
      accepted_at: toMs('2026-09-30T00:00:00Z'),
      event_count: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      facts_digest_version: 1,
      facts_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(first.receipts[0]).not.toHaveProperty('visitor_hash');
    const second = await readBrowserVisitorReceiptPage(
      db,
      firstApp.workspace,
      [firstApp],
      day,
      2,
      first.next_cursor ?? undefined,
    );
    expect(second.receipts.map((receipt) => receipt.batch_id)).toEqual(['receipt-c']);
    expect(second.next_cursor).toBeNull();

    await expect(
      readBrowserVisitorReceiptPage(
        db,
        firstApp.workspace,
        [firstApp],
        day,
        MAX_BROWSER_VISITOR_RECEIPT_PAGE_SIZE + 1,
      ),
    ).rejects.toThrow('bounded query limit');
  });

  it('exposes legacy receipt metadata as null so offline audits can report it incomplete', async () => {
    const item = batch({ batch_id: 'legacy-page-receipt' });
    await acceptBrowserVisitorBatch(db, item, item.received_at);
    await db
      .prepare(
        `UPDATE browser_visitor_batch_receipts
         SET accepted_at = NULL, event_count = NULL, facts_digest_version = NULL, facts_digest = NULL
         WHERE batch_id = ?`,
      )
      .bind(item.batch_id)
      .run();

    const page = await readBrowserVisitorReceiptPage(
      db,
      firstApp.workspace,
      [firstApp],
      '2026-09-30',
    );
    expect(page.receipts).toMatchObject([
      {
        batch_id: item.batch_id,
        accepted_at: null,
        event_count: null,
        facts_digest_version: null,
        facts_digest: null,
      },
    ]);
  });

  it('does not invent a visitor for a missing hash and rejects a reused batch id with changed facts', async () => {
    const noHash = batch({ visitor_hash: undefined });
    await acceptBrowserVisitorBatch(db, noHash, noHash.received_at);
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM browser_visitor_days').first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_batch_receipts')
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_receipt_days')
        .first<{ n: number }>(),
    ).toEqual({ n: 1 });

    const original = batch({ batch_id: 'same-batch' });
    await acceptBrowserVisitorBatch(db, original, original.received_at);
    const changed = batch({ batch_id: 'same-batch', visitor_hash: VISITOR_B });
    await expect(acceptBrowserVisitorBatch(db, changed, changed.received_at)).rejects.toThrow(
      'Browser batch identity reused with different facts',
    );
    expect(
      await db.prepare('SELECT visitor_hash FROM browser_visitor_days ORDER BY visitor_hash').all(),
    ).toMatchObject({ results: [{ visitor_hash: VISITOR_A }] });
  });

  it('rolls back activation and visitor rows when the D1 acceptance transaction fails', async () => {
    const invalidScope = batch({ environment_id: 'missing-environment' });
    await expect(
      acceptBrowserVisitorBatch(db, invalidScope, invalidScope.received_at),
    ).rejects.toThrow();
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_rollup_meta')
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM browser_visitor_days').first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_batch_receipts')
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS n FROM browser_visitor_receipt_days')
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('keeps rows Unknown until 100% rollout, scope activation and full-day closure are proven', async () => {
    const day = '2026-09-28';
    const bounds = { from: toMs('2026-09-27T18:30:00Z'), to: toMs('2026-09-28T18:30:00Z') };
    const now =
      bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    const acceptedAt = bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS - 1_500;
    await acceptBrowserVisitorBatch(
      db,
      batch({
        received_at: acceptedAt,
        events: [
          {
            event_id: crypto.randomUUID(),
            timestamp: bounds.to - 1_000,
            type: 'pageview',
            path: '/late',
            referrer: '',
          },
        ],
      }),
      acceptedAt,
    );
    const scopes = [firstApp, otherApp];
    expect(await readExactBrowserVisitorDays(db, firstApp.workspace, scopes, day, now)).toEqual(
      [firstApp, otherApp].map((scope) => ({
        app_id: scope.app_id,
        environment_id: scope.environment_id,
        complete: false,
        visitors: null,
      })),
    );

    const fullTrafficAt = bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS;
    await attestRollout(firstApp.workspace, 'generation-one', fullTrafficAt);
    await activateScope(firstApp, bounds.from, now);
    await activateScope(otherApp, bounds.from, now);
    expect(await auditAndSeal(firstApp, day, now, 'first-app-day')).toBe(true);
    expect(await auditAndSeal(otherApp, day, now, 'other-app-day')).toBe(true);
    const beforeSettlement = await readExactBrowserVisitorDays(
      db,
      firstApp.workspace,
      scopes,
      day,
      now - 1,
    );
    expect(beforeSettlement.every((row) => !row.complete && row.visitors === null)).toBe(true);
    expect(await readExactBrowserVisitorDays(db, firstApp.workspace, scopes, day, now)).toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: 'prod-a',
        complete: true,
        visitors: 1,
      },
      {
        app_id: otherApp.app_id,
        environment_id: otherApp.environment_id,
        complete: true,
        visitors: 0,
      },
    ]);
    expect(
      await readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], '2026-09-29', now),
    ).toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('bounds one grouped read to 128 app/environment scopes', async () => {
    const scopes = Array.from({ length: MAX_EXACT_BROWSER_VISITOR_SCOPES }, (_, index) => ({
      app_id: `app-${index}`,
      environment_id: `prod-${index}`,
    }));
    const rows = await readExactBrowserVisitorDays(
      db,
      firstApp.workspace,
      scopes,
      '2026-09-28',
      toMs('2026-10-01T00:00:00Z'),
    );
    expect(rows).toHaveLength(MAX_EXACT_BROWSER_VISITOR_SCOPES);
    expect(rows.every((row) => !row.complete && row.visitors === null)).toBe(true);
    await expect(
      readExactBrowserVisitorDays(
        db,
        firstApp.workspace,
        [...scopes, { app_id: 'app-overflow', environment_id: 'prod-overflow' }],
        '2026-09-28',
        toMs('2026-10-01T00:00:00Z'),
      ),
    ).rejects.toThrow('bounded query limit');
  });

  it('requires 100% source SHA evidence and the cutover future-skew fence', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const now =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    const unsafeCutover = from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS + 1;
    await attestRollout('workspace-cutover', 'unsafe-generation', unsafeCutover);
    await recordBrowserVisitorScopeActivation(db, {
      workspace_id: 'workspace-cutover',
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      activated_at: from,
      verified_at: now,
      tracker_source_sha: TRACKER_SHA,
    });

    await expect(
      confirmBrowserVisitorRolloutFullTraffic(db, {
        workspace_id: 'workspace-cutover',
        generation_id: 'missing-generation',
        worker_version_id: 'missing-version',
        source_sha: WORKER_SHA,
        full_traffic_at: from,
        observed_at: from,
        traffic_percent: 99,
      }),
    ).rejects.toThrow('100%');
    await expect(
      readExactBrowserVisitorDays(db, 'workspace-cutover', [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('fails closed when either provider audit stops before the late-event close', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const closeAt =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    const now = closeAt + 1;
    await attestRollout(
      firstApp.workspace,
      'generation-audit-gap',
      from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, from - 1000, now);
    await recordBrowserVisitorCoverageAudit(db, {
      workspace_id: firstApp.workspace,
      audit_id: 'worker-audit-short',
      audit_kind: 'worker_rollouts',
      audited_through: closeAt - 1,
      observed_at: now,
      evidence_sha: AUDIT_SHA,
    });
    await recordBrowserVisitorCoverageAudit(db, {
      workspace_id: firstApp.workspace,
      audit_id: 'scope-audit-complete',
      audit_kind: 'tracker_scope',
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      audited_through: closeAt,
      observed_at: now,
      evidence_sha: AUDIT_SHA,
    });

    expect(
      await sealExactBrowserVisitorDay(db, {
        workspace_id: firstApp.workspace,
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        day,
        now,
      }),
    ).toBe(false);
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('does not let an old open activation mask a later closed overlapping activation', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const now =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    await attestRollout(
      firstApp.workspace,
      'generation-overlap',
      from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, from - BROWSER_VISITOR_DAY_MS, from);
    const overlappingSha = 'f'.repeat(40);
    await recordBrowserVisitorScopeActivation(db, {
      workspace_id: firstApp.workspace,
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      activated_at: from + 1000,
      verified_at: from + 2000,
      tracker_source_sha: overlappingSha,
    });
    await deactivateBrowserVisitorScope(db, {
      workspace_id: firstApp.workspace,
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      activated_at: from + 1000,
      tracker_source_sha: overlappingSha,
      deactivated_at: to + 1,
    });

    expect(await auditAndSeal(firstApp, day, now, 'overlap-day')).toBe(false);
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('serializes a delayed final receipt against the day seal without producing a false zero', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const closeAt =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    const eventAt = to - 1;
    const sealTime = closeAt;
    const acceptedAt = eventAt + BROWSER_VISITOR_MAX_LATENESS_MS;
    const receipt = batch({
      batch_id: 'race-final-receipt',
      received_at: acceptedAt,
      visitor_hash: VISITOR_A,
      events: [
        { event_id: 'race-event', timestamp: eventAt, type: 'pageview', path: '/', referrer: '' },
      ],
    });
    await attestRollout(
      firstApp.workspace,
      'generation-race',
      from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, from, sealTime);
    await recordBrowserVisitorCoverageAudit(db, {
      workspace_id: firstApp.workspace,
      audit_id: 'worker-race-audit',
      audit_kind: 'worker_rollouts',
      audited_through: closeAt,
      observed_at: sealTime,
      evidence_sha: AUDIT_SHA,
    });
    await recordBrowserVisitorCoverageAudit(db, {
      workspace_id: firstApp.workspace,
      audit_id: 'scope-race-audit',
      audit_kind: 'tracker_scope',
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      audited_through: closeAt,
      observed_at: sealTime,
      evidence_sha: AUDIT_SHA,
    });

    const [accepted, sealed] = await Promise.allSettled([
      acceptBrowserVisitorBatch(db, receipt, acceptedAt),
      sealExactBrowserVisitorDay(db, {
        workspace_id: firstApp.workspace,
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        day,
        now: sealTime,
      }),
    ]);
    expect(sealed.status).toBe('fulfilled');
    const exact = await readExactBrowserVisitorDays(
      db,
      firstApp.workspace,
      [firstApp],
      day,
      sealTime,
    );
    if (accepted.status === 'fulfilled') {
      expect(exact).toEqual([
        {
          app_id: firstApp.app_id,
          environment_id: firstApp.environment_id,
          complete: true,
          visitors: 1,
        },
      ]);
    } else {
      expect(exact).toEqual([
        {
          app_id: firstApp.app_id,
          environment_id: firstApp.environment_id,
          complete: true,
          visitors: 0,
        },
      ]);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM browser_visitor_batch_receipts WHERE batch_id = 'race-final-receipt'",
          )
          .first<{ n: number }>(),
      ).toEqual({ n: 0 });
    }
  });

  it('rejects a post-seal multi-day receipt without partially accepting its open day', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const closeAt =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    await attestRollout(
      firstApp.workspace,
      'generation-seal-first',
      from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, from - 1000, closeAt);
    expect(await auditAndSeal(firstApp, day, closeAt, 'seal-first-day')).toBe(true);

    const acceptedAt = to + BROWSER_VISITOR_MAX_LATENESS_MS - 1;
    const lateRetry = batch({
      batch_id: 'sealed-multi-day-batch',
      received_at: acceptedAt,
      events: [
        {
          event_id: 'sealed-day-event',
          timestamp: to - 1,
          type: 'pageview',
          path: '/',
          referrer: '',
        },
        {
          event_id: 'open-day-event',
          timestamp: to + 1,
          type: 'pageview',
          path: '/next',
          referrer: '',
        },
      ],
    });
    await expect(acceptBrowserVisitorBatch(db, lateRetry, acceptedAt)).rejects.toThrow(
      'sealed or incomplete event day',
    );
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM browser_visitor_batch_receipts WHERE batch_id = 'sealed-multi-day-batch'",
        )
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM browser_visitor_days').first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, closeAt),
    ).toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: true,
        visitors: 0,
      },
    ]);
    expect(
      await readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], '2026-09-29', closeAt),
    ).toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('invalidates a day intersecting a partial rollout and qualifies only a later full day', async () => {
    const day = '2026-09-28';
    const bounds = { from: toMs('2026-09-27T18:30:00Z'), to: toMs('2026-09-28T18:30:00Z') };
    const nextDayFrom = bounds.to;
    const fullTrafficAt = nextDayFrom - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS;
    await attestRollout(
      firstApp.workspace,
      'generation-before-partial',
      bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, bounds.from - BROWSER_VISITOR_DAY_MS, bounds.from);
    await recordBrowserVisitorRolloutStart(db, {
      workspace_id: firstApp.workspace,
      generation_id: 'generation-partial',
      worker_version_id: 'version-partial',
      source_sha: WORKER_SHA,
      rollout_started_at: bounds.from + 1_000,
      rollout_observed_at: bounds.from + 1_500,
      rollout_traffic_percent: 10,
    });
    await expect(
      readExactBrowserVisitorDays(
        db,
        firstApp.workspace,
        [firstApp],
        day,
        bounds.to +
          BROWSER_VISITOR_MAX_LATENESS_MS +
          BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS,
      ),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);

    await confirmBrowserVisitorRolloutFullTraffic(db, {
      workspace_id: firstApp.workspace,
      generation_id: 'generation-partial',
      worker_version_id: 'version-partial',
      source_sha: WORKER_SHA,
      full_traffic_at: fullTrafficAt,
      observed_at: fullTrafficAt + 500,
      traffic_percent: 100,
    });
    const nextDay = '2026-09-29';
    const nextDayTo = nextDayFrom + BROWSER_VISITOR_DAY_MS;
    const nextDayNow =
      nextDayTo + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    expect(await auditAndSeal(firstApp, nextDay, nextDayNow)).toBe(true);
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], nextDay, nextDayNow),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: true,
        visitors: 0,
      },
    ]);
  });

  it('invalidates an older full rollout when a newer partial rollout begins before the day', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const now =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    await attestRollout(firstApp.workspace, 'generation-older-full', from - 10 * 60_000);
    await recordBrowserVisitorRolloutStart(db, {
      workspace_id: firstApp.workspace,
      generation_id: 'generation-newer-partial',
      worker_version_id: 'version-newer-partial',
      source_sha: WORKER_SHA,
      rollout_started_at: from - 5 * 60_000,
      rollout_observed_at: from - 4 * 60_000,
      rollout_traffic_percent: 10,
    });
    await activateScope(firstApp, from - BROWSER_VISITOR_DAY_MS, from - BROWSER_VISITOR_DAY_MS);

    expect(await auditAndSeal(firstApp, day, now, 'partial-before-day')).toBe(false);
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('qualifies an activated zero for hashless accepted batches without calling it people', async () => {
    const day = '2026-09-28';
    const from = toMs('2026-09-27T18:30:00Z');
    const to = from + BROWSER_VISITOR_DAY_MS;
    const acceptedAt = from + 1_000;
    const now =
      to + BROWSER_VISITOR_MAX_LATENESS_MS + BROWSER_VISITOR_ACCEPTANCE_SETTLEMENT_GRACE_MS;
    await attestRollout(
      firstApp.workspace,
      'generation-hashless',
      from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
    );
    await activateScope(firstApp, from, now);
    await acceptBrowserVisitorBatch(
      db,
      batch({
        batch_id: 'accepted-hashless',
        received_at: acceptedAt,
        visitor_hash: undefined,
        events: [
          {
            event_id: 'event-hashless',
            timestamp: from + 2_000,
            type: 'pageview',
            path: '/',
            referrer: '',
          },
        ],
      }),
      acceptedAt,
    );
    expect(await auditAndSeal(firstApp, day, now, 'hashless-day')).toBe(true);
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: true,
        visitors: 0,
      },
    ]);
    await deactivateBrowserVisitorScope(db, {
      workspace_id: firstApp.workspace,
      app_id: firstApp.app_id,
      environment_id: firstApp.environment_id,
      activated_at: from,
      tracker_source_sha: TRACKER_SHA,
      deactivated_at: to - 1,
    });
    await expect(
      readExactBrowserVisitorDays(db, firstApp.workspace, [firstApp], day, now),
    ).resolves.toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        complete: false,
        visitors: null,
      },
    ]);
  });

  it('requires production environment activation and rejects unverified scopes', async () => {
    await expect(
      recordBrowserVisitorScopeActivation(db, {
        workspace_id: firstApp.workspace,
        app_id: firstApp.app_id,
        environment_id: otherEnvironment.environment_id,
        activated_at: 1,
        verified_at: 1,
        tracker_source_sha: TRACKER_SHA,
      }),
    ).rejects.toThrow('production');
    await expect(
      recordBrowserVisitorScopeActivation(db, {
        workspace_id: firstApp.workspace,
        app_id: firstApp.app_id,
        environment_id: firstApp.environment_id,
        activated_at: 2,
        verified_at: 1,
        tracker_source_sha: TRACKER_SHA,
      }),
    ).rejects.toThrow('activation proof');
  });

  it('closes a day only after the full late-event window and returns Unknown after retained coverage expires', () => {
    const day = '2026-09-28';
    const bounds = { from: toMs('2026-09-27T18:30:00Z'), to: toMs('2026-09-28T18:30:00Z') };
    const coverage = {
      sourceCutoverAt: bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS,
      reconciledThrough: bounds.to,
    };
    expect(
      browserVisitorDayIsComplete(day, coverage, bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS - 1),
    ).toBe(false);
    expect(
      browserVisitorDayIsComplete(
        day,
        coverage,
        bounds.to + BROWSER_VISITOR_RETENTION_DAYS * BROWSER_VISITOR_DAY_MS,
      ),
    ).toBe(false);
    expect(
      browserVisitorDayIsComplete(
        day,
        { ...coverage, sourceCutoverAt: bounds.from },
        bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS,
      ),
    ).toBe(false);
  });

  it('prunes expired unique rows and receipts in bounded batches', async () => {
    const now = toMs('2026-09-30T00:00:00Z');
    const item = batch();
    await acceptBrowserVisitorBatch(db, item, now);
    await db
      .prepare('UPDATE browser_visitor_days SET expires_at = ?')
      .bind(now - 1)
      .run();
    await db
      .prepare('UPDATE browser_visitor_batch_receipts SET expires_at = ?')
      .bind(now - 1)
      .run();
    expect(await cleanupBrowserVisitorDays(db, now, 1)).toEqual({
      visitors: 1,
      receipts: 1,
      fences: 0,
      audits: 0,
      backlog: { visitors: false, receipts: false, fences: false, audits: false },
    });
    expect(
      await db.prepare('SELECT COUNT(*) AS n FROM browser_visitor_days').first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('reports retention backlog when a bounded cleanup batch cannot catch up', async () => {
    const now = toMs('2026-09-30T00:00:00Z');
    for (const hash of [VISITOR_A, VISITOR_B, 'c'.repeat(64)]) {
      const item = batch({ visitor_hash: hash, batch_id: crypto.randomUUID() });
      await acceptBrowserVisitorBatch(db, item, now);
    }
    await db
      .prepare('UPDATE browser_visitor_days SET expires_at = ?')
      .bind(now - 1)
      .run();
    await db
      .prepare('UPDATE browser_visitor_batch_receipts SET expires_at = ?')
      .bind(now - 1)
      .run();
    expect(await cleanupBrowserVisitorDays(db, now, 2)).toEqual({
      visitors: 2,
      receipts: 2,
      fences: 0,
      audits: 0,
      backlog: { visitors: true, receipts: true, fences: false, audits: false },
    });
    expect(await cleanupBrowserVisitorDays(db, now, 2)).toEqual({
      visitors: 1,
      receipts: 1,
      fences: 0,
      audits: 0,
      backlog: { visitors: false, receipts: false, fences: false, audits: false },
    });
  });

  it('prunes stage receipts in bounded batches and reports their cleanup backlog', async () => {
    const now = toMs('2026-09-30T00:00:00Z');
    await db.batch(
      ['batch-a', 'batch-b', 'batch-c'].map((batchId) =>
        db
          .prepare(
            `INSERT INTO browser_queue_stage_receipts
             (workspace_id, app_id, environment_id, batch_id, staged_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind('workspace-a', 'app-a', 'prod-a', batchId, now - 10, now - 1),
      ),
    );

    expect(await cleanupBrowserVisitorDays(db, now, 2)).toEqual({
      visitors: 0,
      receipts: 2,
      fences: 0,
      audits: 0,
      backlog: { visitors: false, receipts: true, fences: false, audits: false },
    });
    expect(await cleanupBrowserVisitorDays(db, now, 2)).toEqual({
      visitors: 0,
      receipts: 1,
      fences: 0,
      audits: 0,
      backlog: { visitors: false, receipts: false, fences: false, audits: false },
    });
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM browser_queue_stage_receipts')
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('upserts stage receipts idempotently in real D1 when a Queue message is redelivered', async () => {
    const firstSeenAt = toMs('2026-09-30T00:00:00Z');
    const batchIdentity = {
      workspace: 'workspace-a',
      app_id: 'app-a',
      environment_id: 'prod-a',
      batch_id: 'redelivered-batch',
    };

    await recordBrowserQueueStageReceipts(db, [batchIdentity], firstSeenAt);
    await recordBrowserQueueStageReceipts(db, [batchIdentity], firstSeenAt + 1_000);

    const receipt = await db
      .prepare(
        `SELECT workspace_id, app_id, environment_id, batch_id, staged_at, expires_at
         FROM browser_queue_stage_receipts WHERE batch_id = ?`,
      )
      .bind(batchIdentity.batch_id)
      .first();
    expect(receipt).toEqual({
      workspace_id: batchIdentity.workspace,
      app_id: batchIdentity.app_id,
      environment_id: batchIdentity.environment_id,
      batch_id: batchIdentity.batch_id,
      staged_at: firstSeenAt,
      expires_at: firstSeenAt + 1_000 + BROWSER_VISITOR_RETENTION_DAYS * BROWSER_VISITOR_DAY_MS,
    });
    expect(JSON.stringify(receipt)).not.toContain('events');
  });

  it('does not return 202 when D1 receipt acceptance fails for a hashless batch after Queue.send', async () => {
    const failedDb = {
      prepare: vi.fn(),
      batch: vi.fn().mockRejectedValue(new Error('D1 unavailable')),
    };
    const send = vi.fn().mockResolvedValue(undefined);
    const env = {
      DB: failedDb,
      BROWSER_EVENTS: { send },
      BROWSER_HISTORY: {},
      BROWSER_ARCHIVE: {},
      BROWSER_ANALYTICS: {},
      WORKSPACE_PRESENCE: { getByName: () => ({ heartbeat: vi.fn() }) },
    } as unknown as BrowserEnvironment;
    const response = await acceptBrowser(
      batch({ visitor_hash: undefined }),
      undefined,
      env,
      {} as AppHealthRepositories,
      false,
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'browser analytics persistence unavailable' });
  });
});
