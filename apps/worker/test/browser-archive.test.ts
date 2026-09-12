import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: unknown,
    ) {}
  },
}));
import { BrowserArchive } from '../src/browser-archive.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

// Only this wrapper injects failures. Production code runs unchanged in workerd,
// against real SQLite Durable Object storage and an actual local R2 binding.
const wrapper = `
export class TestArchive extends BrowserArchive {
  constructor(ctx, env) {
    super(ctx, { BROWSER_HISTORY: { put: async (...args) => {
      const fault = await ctx.storage.get('fault');
      if (fault === 'before') throw new Error('R2 unavailable');
      const result = await env.BUCKET.put(...args);
      await ctx.storage.put('lastPutCreated', result !== null);
      if (fault === 'after') throw new Error('R2 response lost');
      return result;
    } } });
    this.testCtx = ctx;
  }
  async fault(mode) { await this.testCtx.storage.put('fault', mode); }
  async inspect() {
    return { ...this.status(), alarm: await this.testCtx.storage.getAlarm(),
      segments: this.testCtx.storage.sql.exec('SELECT * FROM archive_segments').toArray(),
      expiry: this.testCtx.storage.sql.exec('SELECT MIN(expires_at) AS value FROM archive_seen').one().value,
      lastPutCreated: await this.testCtx.storage.get('lastPutCreated') };
  }
  expire() { this.testCtx.storage.sql.exec('UPDATE archive_seen SET expires_at = 1 WHERE expires_at IS NOT NULL'); }
  fillLedger() {
    this.testCtx.storage.sql.exec(
      "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 250000) INSERT INTO archive_seen SELECT 'synthetic-' || value, 'fingerprint', ? FROM n",
      Date.now() + 86400000);
  }
}
export default { async fetch(request, env) {
  const { action, value, shard = 'test' } = await request.json();
  const stub = env.ARCHIVE.get(env.ARCHIVE.idFromName(shard));
  try { return Response.json((await stub[action](value)) ?? null); }
  catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
} };
`;

function batch(id: string, extra = '') {
  return {
    workspace: 'workspace-one',
    app_id: 'app-one',
    environment_id: 'production',
    batch_id: id,
    received_at: 123,
    events: [{ type: 'pageview', url: 'https://sample.test/', extra }],
  };
}

async function harness() {
  const path = await mkdtemp(join(tmpdir(), 'app-health-archive-'));
  const source = await readFile(new URL('../src/browser-archive.ts', import.meta.url), 'utf8');
  const projection = await readFile(
    new URL('../src/browser-projection.ts', import.meta.url),
    'utf8',
  );
  const archiveSource = source.replace(
    "import { projectBrowserBatch } from './browser-projection.js';",
    '',
  );
  const script =
    ts.transpileModule(projection, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText +
    ts.transpileModule(archiveSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText +
    wrapper;
  const start = () =>
    new Miniflare({
      modules: true,
      script,
      compatibilityDate: '2026-07-22',
      durableObjects: { ARCHIVE: { className: 'TestArchive', useSQLite: true } },
      durableObjectsPersist: join(path, 'do'),
      r2Buckets: ['BUCKET'],
      r2Persist: join(path, 'r2'),
    });
  let mf = start();
  return {
    async call(action: string, value?: unknown, shard = 'test') {
      const response = await mf.dispatchFetch('https://archive.test/', {
        method: 'POST',
        body: JSON.stringify({ action, value, shard }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    bucket: () => mf.getR2Bucket('BUCKET'),
    async restart() {
      await mf.dispose();
      mf = start();
    },
    async dispose() {
      await mf.dispose();
      await rm(path, { recursive: true, force: true });
    },
  };
}

describe('BrowserArchive real SQLite and R2 durability', () => {
  let app: Awaited<ReturnType<typeof harness>>;
  afterEach(async () => {
    if (app) await app.dispose();
  });

  it('bounds pending bytes and segment bytes and schedules threshold flush promptly', async () => {
    app = await harness();
    await app.call('fault', 'before');
    const payloads = Array.from({ length: 100 }, (_, n) => batch(String(n), 'x'.repeat(60_000)));
    expect((await app.call('stage', payloads)).status).toBe(200);
    const full = (await app.call('inspect')).body;
    expect(full.pending_bytes).toBeGreaterThan(6_000_000);
    expect(full.alarm).toBeLessThan(Date.now() + 2000);
    expect((await app.call('flush')).body.error).toBe('R2 unavailable');
    const retry = (await app.call('inspect')).body;
    expect(retry.alarm).toBeGreaterThan(Date.now());
    expect(
      (
        await app.call(
          'stage',
          payloads.slice(0, 40).map((b) => ({ ...b, batch_id: `next-${b.batch_id}` })),
        )
      ).status,
    ).toBe(503);
    expect((await app.call('inspect')).body.pending_batches).toBe(100);
    await app.call('fault', 'none');
    expect(await app.call('flush')).toEqual({ status: 200, body: null });
    const bucket = await app.bucket();
    const objects = (await bucket.list()).objects;
    expect(objects).toHaveLength(1);
    const object = await bucket.get(objects[0].key);
    const raw = gunzipSync(Buffer.from(await object!.arrayBuffer()));
    expect(raw.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const archived = raw.toString().trim().split('\n').length;
    expect(archived).toBeGreaterThan(1);
    expect((await app.call('inspect')).body.pending_batches).toBe(100 - archived);
  }, 30_000);

  it('fails closed at the ledger cap and prunes only a bounded expired slice', async () => {
    app = await harness();
    await app.call('fillLedger');
    expect((await app.call('stage', [batch('one')])).status).toBe(503);
    expect((await app.call('inspect')).body).toMatchObject({
      ledger_batches: 250_000,
      pending_batches: 0,
    });
    await app.call('expire');
    expect((await app.call('stage', [batch('one')])).body.accepted).toHaveLength(1);
    expect((await app.call('inspect')).body).toMatchObject({
      ledger_batches: 249_001,
      pending_batches: 1,
    });
  }, 30_000);

  it('stages once, separates environments, rejects conflicting calls atomically, and arms the alarm', async () => {
    app = await harness();
    const before = Date.now();
    const first = await app.call('stage', [batch('one'), batch('one')]);
    expect(first.body).toEqual({
      accepted: [{ app_id: 'app-one', environment_id: 'production', batch_id: 'one' }],
      duplicates: 1,
    });
    const state = (await app.call('inspect')).body;
    expect(state.pending_batches).toBe(1);
    expect(state.alarm).toBeGreaterThan(before);
    expect(state.alarm).toBeLessThan(Date.now() + 2_000);
    expect((await app.call('stage', [{ ...batch('one'), received_at: 999 }])).body.duplicates).toBe(
      1,
    );
    expect((await app.call('stage', [batch('two'), batch('one', 'changed')])).status).toBe(503);
    expect((await app.call('inspect')).body.pending_batches).toBe(1);
    expect((await app.call('stage', [{ ...batch('other'), workspace: 'another' }])).status).toBe(
      503,
    );
    expect((await app.call('stage', [{ ...batch('one'), environment_id: 'preview' }])).status).toBe(
      200,
    );
    expect((await app.call('inspect')).body.pending_batches).toBe(2);
  });

  it('preserves sealed membership across upload failure and process restart', async () => {
    app = await harness();
    await app.call('stage', [batch('one')]);
    await app.call('fault', 'before');
    expect((await app.call('flush')).status).toBe(503);
    const failed = (await app.call('inspect')).body;
    expect(failed.pending_batches).toBe(1);
    expect((await (await app.bucket()).list()).objects).toHaveLength(0);
    await app.restart();
    expect((await app.call('stage', [batch('one')])).body.duplicates).toBe(1);
    await app.call('stage', [batch('two')]);
    expect((await app.call('inspect')).body.segments).toEqual(failed.segments);
    await app.call('fault', 'none');
    expect(await app.call('flush')).toEqual({ status: 200, body: null });
    expect((await app.call('inspect')).body.pending_batches).toBe(1);
    const bucket = await app.bucket();
    const object = await bucket.get(
      (failed.segments as Array<{ object_key: string }>)[0].object_key,
    );
    expect(JSON.parse(gunzipSync(Buffer.from(await object!.arrayBuffer())).toString())).toEqual(
      batch('one'),
    );
    expect(object!.httpMetadata).toMatchObject({
      contentType: 'application/x-ndjson',
      contentEncoding: 'gzip',
    });
    await app.call('flush');
    expect((await bucket.list()).objects).toHaveLength(2);
    expect((await app.call('inspect')).body.pending_batches).toBe(0);
  }, 30_000);

  it('reuses one immutable object after successful PUT with a lost response, retaining dedupe for 31 days', async () => {
    app = await harness();
    await app.call('stage', [batch('one')]);
    await app.call('fault', 'after');
    expect((await app.call('flush')).status).toBe(503);
    const original = (await (await app.bucket()).list()).objects.map(({ key, etag }) => ({
      key,
      etag,
    }));
    expect(original).toHaveLength(1);
    expect(original[0].key).toMatch(/^browser-v2\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/[^/]+\.jsonl\.gz$/);
    await app.restart();
    await app.call('fault', 'none');
    expect(await app.call('flush')).toEqual({ status: 200, body: null });
    const objects = (await (await app.bucket()).list()).objects;
    expect(objects.map(({ key, etag }) => ({ key, etag }))).toEqual(
      original.map(({ key, etag }) => ({ key, etag })),
    );
    const state = (await app.call('inspect')).body;
    expect(state).toMatchObject({ pending_batches: 0, ledger_batches: 1, segments: [] });
    expect(state.lastPutCreated).toBe(false);
    expect(state.expiry).toBeGreaterThan(Date.now() + 30 * 86_400_000);
    expect((await app.call('stage', [batch('one')])).body.duplicates).toBe(1);
    await app.call('expire');
    expect((await app.call('stage', [batch('one')])).body.duplicates).toBe(1);
  }, 30_000);

  it('rejects oversize and whole calls at the pending batch cap without partial acceptance', async () => {
    app = await harness();
    expect((await app.call('stage', [batch('large', 'x'.repeat(65_536))])).status).toBe(503);
    expect(
      (
        await app.call(
          'stage',
          Array.from({ length: 101 }, (_, n) => batch(String(n))),
        )
      ).status,
    ).toBe(503);
    for (let page = 0; page < 10; page++) {
      expect(
        (
          await app.call(
            'stage',
            Array.from({ length: 100 }, (_, n) => batch(String(page * 100 + n))),
          )
        ).status,
      ).toBe(200);
    }
    const before = (await app.call('inspect')).body;
    expect(before.pending_batches).toBe(1000);
    expect(
      (
        await app.call(
          'stage',
          Array.from({ length: 25 }, (_, n) => batch(String(1000 + n))),
        )
      ).status,
    ).toBe(503);
    expect((await app.call('inspect')).body).toEqual(before);
    expect((await app.call('stage', [batch('0')])).body.duplicates).toBe(1);
  }, 30_000);
});

function unitArchive(withAnalytics = false) {
  const db = new DatabaseSync(':memory:');
  const statements: string[] = [];
  let alarm: number | null = null;
  let ready = Promise.resolve();
  const objects = new Map<string, ArrayBuffer>();
  const put = vi.fn(async (key: string, data: ArrayBuffer) => {
    if (objects.has(key)) return null;
    objects.set(key, data);
    return { key };
  });
  const writeDataPoint = vi.fn();
  const storage = {
    sql: {
      exec(query: string, ...bindings: (string | number | null)[]) {
        statements.push(query);
        if (query.includes('CREATE TABLE')) {
          db.exec(query);
          return { toArray: () => [], one: () => undefined };
        }
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value;
    },
    sync: vi.fn(async () => {}),
    transactionSync<T>(run: () => T): T {
      db.exec('BEGIN');
      try {
        const value = run();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const ctx = {
    storage,
    id: { toString: () => 'unit-shard' },
    blockConcurrencyWhile(run: () => Promise<void>) {
      ready = run();
    },
  };
  const create = () =>
    new BrowserArchive(ctx as unknown as DurableObjectState, {
      BROWSER_HISTORY: { put } as unknown as Pick<R2Bucket, 'put' | 'list' | 'delete'>,
      ...(withAnalytics ? { BROWSER_ANALYTICS: { writeDataPoint } } : {}),
    });
  const archive = create();
  return {
    archive,
    create,
    db,
    statements,
    objects,
    put,
    writeDataPoint,
    storage,
    ready: () => ready,
    clearAlarm: () => {
      alarm = null;
    },
  };
}

const collected = (id: string) => batch(id) as unknown as CollectedBrowserBatch;

describe('BrowserArchive instrumented SQLite coverage and counter invariants', () => {
  let unit: ReturnType<typeof unitArchive>;
  afterEach(() => {
    unit?.db.close();
    vi.restoreAllMocks();
  });

  it('keeps constant-time counters through rollback, duplicate stages, restart, archival and expiry', async () => {
    unit = unitArchive();
    await unit.ready();
    await unit.archive.stage([collected('a'), collected('a')]);
    const staged = unit.archive.status();
    expect(staged).toMatchObject({ pending_batches: 1, ledger_batches: 1 });
    expect(staged.pending_bytes).toBe(Buffer.byteLength(JSON.stringify(collected('a')) + '\n'));
    await expect(
      unit.archive.stage([
        collected('b'),
        { ...collected('a'), events: collected('a').events.concat(collected('a').events) },
      ]),
    ).rejects.toThrow('different events');
    expect(unit.archive.status()).toEqual(staged);
    unit.db.exec(`CREATE TRIGGER fail_second_insert BEFORE INSERT ON archive_seen
      WHEN NEW.identity = '${JSON.stringify(['app-one', 'production', 'c'])}'
      BEGIN SELECT RAISE(ABORT, 'injected SQL failure'); END;`);
    await expect(unit.archive.stage([collected('b'), collected('c')])).rejects.toThrow(
      'injected SQL failure',
    );
    expect(unit.archive.status()).toEqual(staged);
    expect(unit.db.prepare('SELECT COUNT(*) AS count FROM archive_pending').get()!.count).toBe(1);
    unit.db.exec('DROP TABLE archive_counts');
    unit.create();
    await unit.ready();
    expect(unit.archive.status()).toEqual(staged);
    unit.statements.length = 0;
    const restarted = unit.create();
    await unit.ready();
    await restarted.stage([collected('a')]);
    expect(unit.statements.some((sql) => /COUNT\(|SUM\(/.test(sql))).toBe(false);
    await Promise.all([restarted.flush(), restarted.flush()]);
    expect(unit.put).toHaveBeenCalledTimes(1);
    expect(restarted.status()).toEqual({ pending_batches: 0, pending_bytes: 0, ledger_batches: 1 });
    await restarted.flush();
    unit.db.exec('DELETE FROM projection_pending');
    unit.db.exec('UPDATE archive_seen SET expires_at = 1');
    unit.clearAlarm();
    await restarted.alarm();
    expect(restarted.status()).toEqual({ pending_batches: 0, pending_bytes: 0, ledger_batches: 0 });
    expect(unit.storage.sync).toHaveBeenCalledTimes(2);
  });

  it('retains raw data and counters on failed PUT and retries the same sealed membership', async () => {
    unit = unitArchive();
    await unit.ready();
    await unit.archive.stage([collected('a')]);
    unit.put.mockRejectedValueOnce(new Error('unavailable'));
    await expect(unit.archive.flush()).rejects.toThrow('unavailable');
    const failed = unit.archive.status();
    await unit.archive.stage([collected('b')]);
    unit.clearAlarm();
    await unit.archive.alarm();
    expect(unit.put).toHaveBeenCalledTimes(1);
    await unit.archive.flush();
    expect(unit.archive.status()).toMatchObject({ pending_batches: 1, ledger_batches: 2 });
    expect(failed).toMatchObject({ pending_batches: 1, ledger_batches: 1 });
    expect(unit.put.mock.calls[0][0]).toBe(unit.put.mock.calls[1][0]);
    await unit.archive.alarm();
    await unit.archive.flush();
    expect(unit.archive.status().pending_bytes).toBe(0);
    expect(
      [...unit.objects.values()].map(
        (data) => JSON.parse(gunzipSync(Buffer.from(data)).toString()).batch_id,
      ),
    ).toEqual(['a', 'b']);
  });

  it('rejects invalid calls and atomically applies each capacity limit', async () => {
    unit = unitArchive();
    await unit.ready();
    await expect(
      unit.archive.stage(Array.from({ length: 101 }, () => collected('a'))),
    ).rejects.toThrow('100');
    await expect(unit.archive.stage([{ ...collected('a'), batch_id: '' }])).rejects.toThrow(
      'identity',
    );
    await expect(unit.archive.stage([{ ...collected('a'), events: [] }])).rejects.toThrow('events');
    await expect(
      unit.archive.stage([batch('a', 'x'.repeat(65_536)) as unknown as CollectedBrowserBatch]),
    ).rejects.toThrow('64 KiB');
    expect(await unit.archive.stage([])).toEqual({ accepted: [], duplicates: 0 });
    await unit.archive.stage([collected('a')]);
    await expect(unit.archive.stage([{ ...collected('b'), workspace: 'other' }])).rejects.toThrow(
      'workspace',
    );
    for (const column of ['pending_batches', 'pending_bytes', 'ledger_batches']) {
      unit.db.exec(`UPDATE archive_counts SET ${column} = 999999999`);
      const before = unit.archive.status();
      await expect(unit.archive.stage([collected('b')])).rejects.toThrow('capacity');
      expect(unit.archive.status()).toEqual(before);
      expect(unit.db.prepare('SELECT COUNT(*) AS count FROM archive_seen').get()!.count).toBe(1);
      unit.db.exec(`UPDATE archive_counts SET ${column} = 0`);
    }
  });

  it('seals bounded segments and expedites alarms at the byte threshold', async () => {
    unit = unitArchive();
    await unit.ready();
    await unit.archive.stage(
      Array.from(
        { length: 20 },
        (_, n) => batch(String(n), 'x'.repeat(60_000)) as unknown as CollectedBrowserBatch,
      ),
    );
    expect(await unit.storage.getAlarm()).toBeLessThan(Date.now() + 2000);
    await unit.archive.alarm();
    expect(unit.archive.status().pending_batches).toBeGreaterThan(0);
    const raw = gunzipSync(Buffer.from([...unit.objects.values()][0]));
    expect(raw.byteLength).toBeLessThanOrEqual(1024 * 1024);
    await unit.archive.flush();
    expect(unit.archive.status()).toMatchObject({
      pending_batches: 0,
      pending_bytes: 0,
      ledger_batches: 20,
    });
  });
});

describe('BrowserArchive projection outbox', () => {
  it('retains projection work when the analytics binding is unavailable', async () => {
    const unit = unitArchive();
    await unit.ready();
    await unit.archive.stage([collected('missing-binding')]);
    expect(unit.db.prepare('SELECT COUNT(*) AS count FROM projection_pending').get()!.count).toBe(
      1,
    );
    unit.db.close();
  });

  it('runs an early projection alarm without flushing a tiny R2 segment', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    await unit.archive.stage([collected('early-projection')]);
    await unit.archive.alarm();
    expect(unit.writeDataPoint!).toHaveBeenCalledTimes(1);
    expect(unit.put).not.toHaveBeenCalled();
    unit.db.close();
  });

  it('rejects new projection work at its independent bounded backlog', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    unit.db.exec(
      "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 1024) INSERT INTO projection_pending(identity, payload, attempts, next_attempt_at, bytes) SELECT 'full-' || value, '{}', 0, 0, 1 FROM n",
    );
    unit.db.exec('UPDATE projection_counts SET pending_batches = 1024, pending_bytes = 8388608');
    await expect(unit.archive.stage([collected('backlog-full')])).rejects.toThrow('capacity');
    unit.db.close();
  });

  it('deduplicates metadata changes but rejects immutable visitor changes', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    const original = collected('fingerprint');
    await unit.archive.stage([
      { ...original, metadata: { channel: '', device: 'mobile', browser: '', country: '' } },
    ]);
    expect(
      (
        await unit.archive.stage([
          { ...original, metadata: { channel: '', device: 'desktop', browser: '', country: '' } },
        ])
      ).duplicates,
    ).toBe(1);
    await expect(
      unit.archive.stage([{ ...original, visitor_hash: 'changed-visitor' }]),
    ).rejects.toThrow('identity reused');
    unit.db.close();
  });

  it('does not spin expiry alarms for projection-pending identities', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    await unit.archive.stage([collected('expired-projection')]);
    unit.db.exec('UPDATE archive_seen SET expires_at = 1');
    unit.db
      .prepare('UPDATE projection_pending SET next_attempt_at = ?')
      .run(Date.now() + 60 * 60_000);
    unit.clearAlarm();
    await unit.archive.alarm();
    expect(await unit.storage.getAlarm()).toBeGreaterThan(Date.now() + 59_000);
    unit.db.close();
  });

  it('retains staged projection work across restart and clears it after delivery', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    await unit.archive.stage([collected('outbox')]);
    expect(unit.db.prepare('SELECT COUNT(*) AS count FROM projection_pending').get()!.count).toBe(
      1,
    );
    const restarted = unit.create();
    await unit.ready();
    await restarted.alarm();
    expect(unit.writeDataPoint!).toHaveBeenCalledTimes(1);
    expect(unit.db.prepare('SELECT COUNT(*) AS count FROM projection_pending').get()!.count).toBe(
      0,
    );
    unit.db.close();
  });

  it('keeps failed projection work for a bounded backoff retry', async () => {
    const unit = unitArchive(true);
    await unit.ready();
    unit.writeDataPoint!.mockImplementationOnce(() => {
      throw new Error('projection unavailable');
    });
    await unit.archive.stage([collected('retry-projection')]);
    await unit.archive.alarm();
    const row = unit.db
      .prepare('SELECT attempts, next_attempt_at FROM projection_pending')
      .get() as { attempts: number; next_attempt_at: number };
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThan(Date.now());
    unit.db.close();
  });
});
