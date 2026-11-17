import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import type { NativeArchiveResult } from '../src/browser-archive-native-verifier.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const timestamp = Date.now() - 3 * 86_400_000;
const day = new Date(timestamp + 19_800_000).toISOString().slice(0, 10);
const scope = { workspace: 'w', app_id: 'a', environment_id: 'e', day };
let mf: Miniflare | undefined;
afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

async function runtime() {
  const archive = fileURLToPath(new URL('../src/browser-archive.ts', import.meta.url));
  const routes = fileURLToPath(new URL('../src/browser-routes.ts', import.meta.url));
  const source = `
import { BrowserArchive } from ${JSON.stringify(archive)};
import { handleBrowserOwner } from ${JSON.stringify(routes)};
export class TestArchive extends BrowserArchive {
  async inspectRole() { return { name: this.ctx.id.name ?? null, tables: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'archive_%' OR name LIKE 'projection_%'").toArray(), alarm: await this.ctx.storage.getAlarm() }; }
  async guardedAlarm() { await this.alarm(); return this.inspectRole(); }
}
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/rpc') {
    const value = await request.json();
    const stub = value.missingName ? env.BROWSER_ARCHIVE.get(env.BROWSER_ARCHIVE.newUniqueId()) : env.BROWSER_ARCHIVE.getByName(value.name);
    try { return Response.json(await stub[value.method](...value.args)); }
    catch { return Response.json({ denied: true }, { status: 403 }); }
  }
  const owner = { id: 'owner', authKind: request.headers.get('x-test-auth') ?? 'account', workspaceRole: request.headers.get('x-test-role') ?? 'owner', workspaceId: request.headers.get('x-test-workspace') ?? 'w', appIds: request.headers.has('x-test-revoked') ? [] : ['a'] };
  return await handleBrowserOwner(request, env, owner, false) ?? new Response('not found', { status: 404 });
} };`;
  const bundled = await build({
    stdin: { contents: source, resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    external: ['cloudflare:workers'],
    define: { __APP_HEALTH_BUILD_SHA__: JSON.stringify('a'.repeat(40)) },
  });
  mf = new Miniflare({
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-07-22',
    cf: false,
    durableObjects: { BROWSER_ARCHIVE: { className: 'TestArchive', useSQLite: true } },
    r2Buckets: ['BROWSER_HISTORY'],
    d1Databases: ['DB'],
    outboundService: () => new Response('blocked', { status: 503 }),
  });
  const db = await mf.getD1Database('DB');
  await db.exec(
    'CREATE TABLE browser_visitor_batch_receipts(workspace_id TEXT,app_id TEXT,environment_id TEXT,batch_id TEXT,fingerprint TEXT,accepted_at INTEGER,event_count INTEGER,facts_digest_version INTEGER,facts_digest TEXT,expanded_facts_digest TEXT);CREATE TABLE browser_visitor_receipt_days(workspace_id TEXT,india_day TEXT,app_id TEXT,environment_id TEXT,batch_id TEXT);CREATE TABLE environments(id TEXT,app_id TEXT,name TEXT);CREATE TABLE workspace_apps(workspace_id TEXT,app_id TEXT);',
  );
  await db.exec(
    "INSERT INTO environments VALUES('e','a','Production');INSERT INTO workspace_apps VALUES('w','a');",
  );
  const bucket = await mf.getR2Bucket('BROWSER_HISTORY');
  async function put(rows: CollectedBrowserBatch[], index = 0) {
    const partition = new Date(timestamp).toISOString().slice(0, 10).replaceAll('-', '/');
    const key = `browser-v2/${partition}/${'b'.repeat(64)}/${String(index).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl.gz`;
    const raw = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const compressed = gzipSync(raw);
    const times = rows.flatMap((row) => row.events.map((event) => event.timestamp));
    const manifest = {
      schema_version: 1,
      object_key: key,
      workspace_id: 'w',
      format: 'jsonl-gzip',
      content_sha256: createHash('sha256').update(compressed).digest('hex'),
      row_count: rows.length,
      event_count: times.length,
      min_event_at: Math.min(...times),
      max_event_at: Math.max(...times),
      uncompressed_bytes: raw.length,
      compressed_bytes: compressed.length,
      created_at: timestamp,
      state: 'active',
    };
    await bucket.put(key, compressed, { customMetadata: { manifest: JSON.stringify(manifest) } });
    return { key, compressed, manifest };
  }
  async function owner(
    action = '',
    value: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    const response = await mf!.dispatchFetch(
      'https://owner.test/v1/browser/native-archive-audits' + action,
      {
        method: 'POST',
        headers: { origin: 'https://owner.test', ...headers },
        body: JSON.stringify({ app_id: 'a', environment_id: 'e', day, ...value }),
      },
    );
    return { status: response.status, value: (await response.json()) as NativeArchiveResult };
  }
  async function rpc(name: string, method: string, args: unknown[] = [], missingName = false) {
    const response = await mf!.dispatchFetch('https://owner.test/rpc', {
      method: 'POST',
      body: JSON.stringify({ name, method, args, missingName }),
    });
    return { status: response.status, value: (await response.json()) as Record<string, unknown> };
  }
  async function finish(state: NativeArchiveResult) {
    for (let i = 0; state.phase !== 'terminal' && i < 100; i++) {
      const result = await owner('/advance', { session_id: state.session_id, seq: state.seq });
      expect(result.status).toBe(200);
      state = result.value;
    }
    return state;
  }
  return { db, bucket, put, owner, rpc, finish };
}

describe('native verifier workerd HTTP and bindings', () => {
  it('uses actual R2 compressed bytes, global comparison, fresh D1 receipts and owner HTTP scope revocation', async () => {
    const app = await runtime();
    const row: CollectedBrowserBatch = {
      ...scope,
      batch_id: 'b',
      received_at: timestamp,
      events: [
        {
          event_id: 'event',
          type: 'pageview',
          timestamp,
          path: '/private',
          referrer: '',
          properties: { keep: true },
        },
      ],
      facts_digest_version: 2,
    };
    row.facts_digest = await digestBrowserEventFacts(row);
    await app.put([row]);
    await app.db
      .prepare('INSERT INTO browser_visitor_batch_receipts VALUES(?,?,?,?,?,?,?,?,?,NULL)')
      .bind('w', 'a', 'e', 'b', 'fingerprint', timestamp, 1, 2, row.facts_digest)
      .run();
    await app.db
      .prepare('INSERT INTO browser_visitor_receipt_days VALUES(?,?,?,?,?)')
      .bind('w', day, 'a', 'e', 'b')
      .run();
    const started = await app.owner();
    expect(started.status).toBe(200);
    expect(started.value).toMatchObject({
      inner_execution_sha: 'a'.repeat(40),
      outer_execution_sha: 'a'.repeat(40),
    });
    const session_id = started.value.session_id;
    for (const action of ['/status', '/advance']) {
      const input = { session_id, ...(action === '/advance' ? { seq: 0 } : {}) };
      expect((await app.owner(action, input, { 'x-test-role': 'member' })).status).toBe(403);
      expect((await app.owner(action, input, { 'x-test-auth': 'api-key' })).status).toBe(403);
      expect((await app.owner(action, input, { 'x-test-revoked': '1' })).status).toBe(404);
      expect((await app.owner(action, input, { 'x-test-workspace': 'foreign' })).status).toBe(404);
    }
    await app.db.exec('DELETE FROM workspace_apps;');
    expect((await app.owner('/status', { session_id })).status).toBe(404);
    await app.db.exec("INSERT INTO workspace_apps VALUES('w','a');");
    expect(await app.finish(started.value)).toMatchObject({
      outcome: 'observed',
      complete: false,
      counts: { matched: 1 },
    });
    const nativeObject = await app.bucket.get((await app.bucket.list()).objects[0]!.key);
    expect(new Uint8Array(await nativeObject!.arrayBuffer()).slice(0, 2)).toEqual(
      new Uint8Array([31, 139]),
    );
  }, 20_000);

  it('isolates the actual class constructor, every producer RPC and alarm from diagnostic and invalid roles', async () => {
    const app = await runtime();
    const id = crypto.randomUUID();
    const name = 'browser-native-audit-v1:' + id;
    const producerMethods = [
      ['stage', [[]]],
      ['lookupStaged', [[]]],
      ['status', []],
      ['archiveSegmentsForEventDay', [day]],
      [
        'archiveSegmentsForScope',
        [{ app_id: 'a', environment_id: 'e', from: timestamp, to: timestamp + 1 }],
      ],
      ['reindexScopeSegments', [day, null, 'w']],
      ['archiveSegmentForBatch', ['a', 'e', 'b']],
      ['flush', []],
      ...[
        'insert',
        'newBatches',
        'archiveDayIndexPage',
        'readScopeIndexBounds',
        'publishScopeIndex',
        'prune',
        'schedule',
        'seal',
        'upload',
        'complete',
        'scopeBounds',
        'replaceScopeSegments',
        'projectPending',
      ].map((name) => [name, []] as const),
    ] as const;
    for (const [method, args] of producerMethods)
      expect((await app.rpc(name, method, [...args])).status).toBe(403);
    expect((await app.rpc(name, 'inspectRole')).value).toMatchObject({
      name,
      tables: [],
      alarm: null,
    });
    expect((await app.rpc(name, 'guardedAlarm')).value).toMatchObject({ tables: [], alarm: null });
    for (const bad of ['malformed', 'w:browser-archive-v1:16'])
      expect((await app.rpc(bad, 'guardedAlarm')).value).toMatchObject({ tables: [], alarm: null });
    expect((await app.rpc('', 'inspectRole', [], true)).value).toMatchObject({
      name: null,
      tables: [],
      alarm: null,
    });
    for (const method of ['startNativeAudit', 'nativeAuditStatus', 'advanceNativeAudit'])
      expect((await app.rpc('w:browser-archive-v1:0', method, [id, scope, 0])).status).toBe(403);
    expect((await app.rpc('w:browser-archive-v1:0', 'inspectRole')).value.tables).not.toEqual([]);
  }, 20_000);
});
