import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import type { BrowserEnvironment } from '../src/browser-routes.js';
import { acceptBrowser } from '../src/browser-routes.js';
import type { AppHealthRepositories } from '../src/repository.js';
import {
  acceptBrowserVisitorBatch,
  readBrowserVisitorReceiptPage,
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
      'CREATE TABLE environments (id TEXT NOT NULL, app_id TEXT NOT NULL, PRIMARY KEY (id, app_id))',
    )
    .run();
  await db.batch([
    db.prepare('INSERT INTO environments (id, app_id) VALUES (?, ?)').bind('prod-a', 'app-a'),
    db.prepare('INSERT INTO environments (id, app_id) VALUES (?, ?)').bind('stage-a', 'app-a'),
    db.prepare('INSERT INTO environments (id, app_id) VALUES (?, ?)').bind('prod-b', 'app-b'),
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
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM browser_visitor_days'),
    db.prepare('DELETE FROM browser_visitor_receipt_days'),
    db.prepare('DELETE FROM browser_visitor_batch_receipts'),
    db.prepare('DELETE FROM browser_visitor_rollup_meta'),
  ]);
});

afterAll(() => mf.dispose());

describe('exact browser visitor daily ledger', () => {
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

  it('keeps rows Unknown until explicit cutover and reconciliation evidence proves a full day', async () => {
    const day = '2026-09-28';
    const bounds = { from: toMs('2026-09-27T18:30:00Z'), to: toMs('2026-09-28T18:30:00Z') };
    const now = bounds.to + BROWSER_VISITOR_MAX_LATENESS_MS;
    await acceptBrowserVisitorBatch(
      db,
      batch({
        received_at: now,
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
      now,
    );
    const scopes = [firstApp, otherEnvironment];
    expect(await readExactBrowserVisitorDays(db, firstApp.workspace, scopes, day, now)).toEqual(
      scopes
        .slice()
        .sort((left, right) => left.environment_id.localeCompare(right.environment_id))
        .map((scope) => ({
          app_id: scope.app_id,
          environment_id: scope.environment_id,
          complete: false,
          visitors: null,
        })),
    );

    const sourceCutoverAt = bounds.from - BROWSER_VISITOR_MAX_FUTURE_SKEW_MS;
    await db
      .prepare(
        `UPDATE browser_visitor_rollup_meta
         SET source_cutover_at = ?, reconciled_through = ?, verified_at = ?
         WHERE workspace_id = ?`,
      )
      .bind(sourceCutoverAt, bounds.to, now, firstApp.workspace)
      .run();
    expect(await readExactBrowserVisitorDays(db, firstApp.workspace, scopes, day, now)).toEqual([
      {
        app_id: firstApp.app_id,
        environment_id: 'prod-a',
        complete: true,
        visitors: 1,
      },
      {
        app_id: firstApp.app_id,
        environment_id: 'stage-a',
        complete: true,
        visitors: 0,
      },
    ]);
    expect(
      browserVisitorDayIsComplete(day, { sourceCutoverAt, reconciledThrough: bounds.to }, now),
    ).toBe(true);
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
      backlog: { visitors: false, receipts: false },
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
      backlog: { visitors: true, receipts: true },
    });
    expect(await cleanupBrowserVisitorDays(db, now, 2)).toEqual({
      visitors: 1,
      receipts: 1,
      backlog: { visitors: false, receipts: false },
    });
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
