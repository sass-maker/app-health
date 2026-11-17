import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NativeBrowserArchiveVerifier,
  browserArchiveRole,
  isNativeArchiveScope,
  nativeArchiveDiagnosticName,
  type NativeArchiveBindings,
  type NativeArchiveResult,
} from '../src/browser-archive-native-verifier.js';
import { digestBrowserEventFacts } from '../src/browser-facts-digest.js';
import type { CollectedBrowserBatch } from '../src/browser-analytics.js';
import type { D1DatabaseLike } from '../src/d1-adapter.js';
import { handleBrowserOwner, type BrowserEnvironment } from '../src/browser-routes.js';
import type { OwnerIdentity } from '../src/identity.js';

const now = Date.parse('2026-11-17T10:00:00Z');
const timestamp = Date.parse('2026-11-12T10:00:00Z');
const scope = { workspace: 'w', app_id: 'a', environment_id: 'e', day: '2026-11-12' };
const key = (n = 0, partition = '2026/11/12') =>
  `browser-v2/${partition}/${'a'.repeat(64)}/${String(n).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl.gz`;
const batch = (id = 'b'): CollectedBrowserBatch => ({
  workspace: 'w',
  app_id: 'a',
  environment_id: 'e',
  batch_id: id,
  received_at: timestamp,
  events: [
    { event_id: 'event-' + id, timestamp, type: 'pageview', path: '/private-path', referrer: '' },
  ],
});
type Fixture = Awaited<ReturnType<typeof fixture>>;
const sessions: Array<{ verifier: NativeBrowserArchiveVerifier; id: string }> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.setSystemTime(now + 2 * 86_400_000);
  for (const { verifier, id } of sessions.splice(0)) {
    try {
      verifier.status(id, scope);
    } catch {
      /* A denied scope cannot retain facts. */
    }
  }
  vi.useRealTimers();
});

async function object(rows: CollectedBrowserBatch[], objectKey = key()) {
  const raw = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const compressed = gzipSync(raw);
  const times = rows.flatMap((row) => row.events.map((event) => event.timestamp));
  const manifest = {
    schema_version: 1,
    object_key: objectKey,
    workspace_id: rows[0]!.workspace,
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
  const metadata = {
    key: objectKey,
    size: compressed.length,
    customMetadata: { manifest: JSON.stringify(manifest) },
  } as unknown as R2Object;
  return {
    metadata,
    manifest,
    compressed,
    body: () => ({ ...metadata, body: new Response(compressed).body! }) as R2ObjectBody,
  };
}

async function fixture(rows: CollectedBrowserBatch[] = [batch()]) {
  for (const row of rows) {
    row.facts_digest_version ??= row.events.some((event) => event.properties !== undefined) ? 2 : 1;
    row.facts_digest ??= await digestBrowserEventFacts(row);
  }
  const initial = rows[0]!;
  const receipt = {
    app_id: 'a',
    environment_id: 'e',
    batch_id: initial.batch_id,
    fingerprint: 'f'.repeat(64),
    accepted_at: timestamp,
    event_count: initial.events.length,
    facts_digest_version: initial.facts_digest_version,
    facts_digest: initial.facts_digest,
  };
  const source = await object(rows);
  const state = {
    receipts: [receipt],
    objects: [source.metadata],
    source,
    receiptCalls: 0,
    listCalls: 0,
    gets: 0,
    owned: true,
  };
  const db = {
    prepare() {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async all() {
          state.receiptCalls++;
          const after = values.length > 4 ? String(values[5]) : '';
          return {
            results: state.receipts
              .filter((row) => row.batch_id > after)
              .slice(0, Number(values.at(-1))),
          };
        },
        async first() {
          return state.owned ? { owned: 1 } : null;
        },
      };
      return statement;
    },
  } as unknown as D1DatabaseLike;
  const history = {
    list: vi.fn(async (options: R2ListOptions) => {
      state.listCalls++;
      return {
        objects: state.objects.filter((row) => row.key.startsWith(options.prefix!)),
        truncated: false,
      } as unknown as R2Objects;
    }),
    get: vi.fn(async () => {
      state.gets++;
      return state.source.body();
    }),
  };
  const bindings = { DB: db, BROWSER_HISTORY: history } as unknown as NativeArchiveBindings;
  const verifier = new NativeBrowserArchiveVerifier(bindings);
  const id = crypto.randomUUID();
  sessions.push({ verifier, id });
  return { state, history, bindings, verifier, id, start: () => verifier.start(id, scope) };
}

async function until(f: Fixture, phase: NativeArchiveResult['phase']) {
  let state = f.verifier.status(f.id, scope);
  for (let index = 0; state.phase !== phase && state.phase !== 'terminal' && index < 4096; index++)
    state = await f.verifier.advance(f.id, scope, state.seq);
  expect(state.phase).toBe(phase);
  return state;
}

async function finish(f: Fixture) {
  return until(f, 'terminal');
}

describe('native scoped archive session', () => {
  it('globally compares whole batches including midnight events, orphan facts and cross-object duplicates', async () => {
    const first = batch();
    first.events.push({
      ...first.events[0]!,
      event_id: 'next-day',
      timestamp: Date.parse('2026-11-12T18:31:00Z'),
    });
    const f = await fixture([first]);
    const orphan = batch('orphan');
    orphan.facts_digest_version = 1;
    orphan.facts_digest = await digestBrowserEventFacts(orphan);
    const second = await object([first, orphan], key(1));
    f.state.objects.push(second.metadata);
    f.history.get.mockImplementation(async (name?: string) =>
      name === second.metadata.key ? second.body() : f.state.source.body(),
    );
    f.start();
    const result = await finish(f);
    expect(result).toMatchObject({
      outcome: 'observed',
      complete: false,
      counts: { matched: 0, duplicate_archive_candidates: 1, archive_only_facts: 1 },
    });
    expect(f.state.receiptCalls).toBe(2);
    expect(f.history.get).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toMatch(
      /private-path|browser-v2|orphan|fingerprint|content_sha256/,
    );
    expect(f.verifier.status(f.id, scope)).toEqual(result);
  });

  it('matches expanded v2 properties and attribution without changing the comparator', async () => {
    const rich = batch();
    rich.events[0]!.properties = { plan: 'pro', seats: 2 };
    rich.facts_digest_version = 2;
    rich.attribution = {
      source: 'direct',
      medium: '',
      campaign: '',
      content: '',
      term: '',
      entry_path: '/',
    };
    const f = await fixture([rich]);
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'observed', counts: { matched: 1 } });
  });

  it('uses every frozen seal prefix from event-day-start minus skew through capture day', async () => {
    const f = await fixture();
    f.start();
    await until(f, 'bodies');
    expect(f.history.list.mock.calls.map((call) => call[0].prefix)).toEqual(
      Array.from({ length: 7 }, (_, i) => `browser-v2/2026/11/${i + 11}/`),
    );
  });

  it.each(['metadata-A', 'metadata-B'] as const)(
    'blocks unknown foreign metadata in %s before exclusion',
    async (phase) => {
      const f = await fixture();
      f.start();
      await until(f, phase);
      f.state.objects.push({ key: key(9), size: 1 } as R2Object);
      expect(await finish(f)).toMatchObject({
        outcome: 'unknown',
        counts: null,
        reasons: ['metadata_invalid'],
      });
    },
  );

  it('permits valid unrelated churn but blocks candidate additions, removals and changes', async () => {
    const f = await fixture();
    f.start();
    await until(f, 'metadata-B');
    const unrelated = await object([{ ...batch(), workspace: 'foreign' }], key(5));
    f.state.objects.push(unrelated.metadata);
    expect(await finish(f)).toMatchObject({ outcome: 'observed', counts: { matched: 1 } });
  });

  it('validates all workspace/day bodies before app/environment exclusion', async () => {
    const f = await fixture();
    const excluded = { ...batch('excluded'), app_id: 'other' };
    Object.assign(excluded.events[0]!, { path: 42 });
    const second = await object([excluded], key(2));
    f.state.objects.push(second.metadata);
    f.history.get.mockImplementation(async (name?: string) =>
      name === second.metadata.key ? second.body() : f.state.source.body(),
    );
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'unknown', counts: null });
    expect(f.history.get).toHaveBeenCalledTimes(2);
  });

  it.each(['plain', 'compressed', 'rows', 'state', 'format'] as const)(
    'rejects candidate %s outside the admitted native envelope',
    async (fault) => {
      const f = await fixture();
      const m = { ...f.state.source.manifest };
      if (fault === 'plain') m.uncompressed_bytes = 768 * 1024 + 1;
      if (fault === 'compressed') m.compressed_bytes = 512 * 1024 + 1;
      if (fault === 'rows') m.row_count = 4097;
      if (fault === 'state')
        Object.assign(m, { state: 'replacement-written', replacement_key: 'replacement' });
      if (fault === 'format') m.format = 'parquet-iceberg';
      f.state.objects = [
        {
          ...f.state.source.metadata,
          size: m.compressed_bytes,
          customMetadata: { manifest: JSON.stringify(m) },
        } as unknown as R2Object,
      ];
      f.start();
      expect(await finish(f)).toMatchObject({ outcome: 'unknown', counts: null });
      expect(f.history.get).not.toHaveBeenCalled();
    },
  );

  it('bounds infinite empty native cursor cycles by the total page budget', async () => {
    const f = await fixture();
    let page = 0;
    f.history.list.mockImplementation(async () => ({
      objects: [],
      delimitedPrefixes: [],
      truncated: true,
      cursor: String(++page % 2),
    }));
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'unknown', reasons: ['metadata_page_cap'] });
    expect(f.history.list).toHaveBeenCalledTimes(512);
  });

  it('rejects duplicate metadata keys and duplicate receipt identities', async () => {
    const f = await fixture();
    f.state.receipts.push({ ...f.state.receipts[0]! });
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'unknown', reasons: ['receipt_cursor'] });
    const next = await fixture();
    next.state.objects.push(next.state.source.metadata);
    next.start();
    expect(await finish(next)).toMatchObject({
      outcome: 'unknown',
      reasons: ['metadata_duplicate'],
    });
  });

  it.each(['add', 'remove', 'manifest', 'outday-to-inday'] as const)(
    'blocks candidate %s between metadata passes',
    async (change) => {
      const f = await fixture();
      const other = await object(
        [
          {
            ...batch('other'),
            events: [{ ...batch().events[0]!, timestamp: timestamp - 2 * 86_400_000 }],
          },
        ],
        key(2),
      );
      if (change === 'outday-to-inday') f.state.objects.push(other.metadata);
      f.start();
      await until(f, 'metadata-B');
      if (change === 'remove') f.state.objects = [];
      if (change === 'add') f.state.objects.push((await object([batch('new')], key(3))).metadata);
      if (change === 'manifest')
        f.state.objects[0] = {
          ...f.state.objects[0]!,
          customMetadata: {
            manifest: JSON.stringify({ ...f.state.source.manifest, created_at: timestamp + 1 }),
          },
        } as unknown as R2Object;
      if (change === 'outday-to-inday')
        f.state.objects[1] = (await object([batch('other')], key(2))).metadata;
      expect(await finish(f)).toMatchObject({
        outcome: 'unknown',
        counts: null,
        reasons: ['candidate_changed'],
      });
    },
  );

  it('follows truncated short and empty native pages and rejects malformed cursors', async () => {
    const f = await fixture();
    let first = true;
    f.history.list.mockImplementation(async (options) => {
      if (first) {
        first = false;
        return { objects: [], truncated: true, cursor: 'opaque-next' } as unknown as R2Objects;
      }
      return {
        objects: f.state.objects.filter((row) => row.key.startsWith(options.prefix!)),
        truncated: false,
      } as unknown as R2Objects;
    });
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'observed', counts: { matched: 1 } });
    expect(f.history.list.mock.calls[1]![0].cursor).toBe('opaque-next');
  });

  it.each([
    { objects: [], truncated: undefined },
    { objects: [], truncated: true, cursor: '' },
    { objects: [], truncated: true, cursor: 'x'.repeat(8193) },
  ])('rejects malformed native list shapes', async (page) => {
    const f = await fixture();
    f.history.list.mockResolvedValue(page as unknown as R2Objects);
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'unknown', reasons: ['metadata_cursor'] });
  });

  it.each([
    'fingerprint',
    'accepted_at',
    'event_count',
    'facts_digest',
    'facts_digest_version',
  ] as const)('rereads full fresh receipt projection and blocks %s mutation', async (field) => {
    const f = await fixture();
    f.start();
    await until(f, 'receipt-final');
    const row = f.state.receipts[0]!;
    Object.assign(row, {
      [field]: typeof row[field] === 'number' ? Number(row[field]) + 1 : 'changed',
    });
    expect(await finish(f)).toMatchObject({
      outcome: 'unknown',
      counts: null,
      reasons: ['receipt_changed'],
    });
  });

  it('blocks fresh receipt disappearance and duplicate identities', async () => {
    const f = await fixture();
    f.start();
    await until(f, 'receipt-final');
    f.state.receipts = [];
    expect(await finish(f)).toMatchObject({ outcome: 'unknown', reasons: ['receipt_changed'] });
  });

  it.each(['key', 'size', 'manifest', 'checksum'] as const)(
    'validates the exact native object against pass A and native bytes for %s',
    async (fault) => {
      const f = await fixture();
      f.start();
      await until(f, 'bodies');
      f.history.get.mockImplementation(async () => {
        const body = f.state.source.body();
        if (fault === 'key') Object.assign(body, { key: key(7) });
        if (fault === 'size') Object.assign(body, { size: body.size + 1 });
        if (fault === 'manifest') Object.assign(body, { customMetadata: {} });
        if (fault === 'checksum')
          Object.assign(body, { body: new Response(gzipSync('corrupt\n')).body });
        return body;
      });
      expect(await finish(f)).toMatchObject({ outcome: 'unknown', counts: null });
      expect(f.history.get).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps legacy receipt and missing digest classifications', async () => {
    const f = await fixture();
    f.state.receipts[0]!.facts_digest_version = undefined;
    Object.assign(f.state.receipts[0]!, { facts_digest_version: null, facts_digest: null });
    f.start();
    expect(await finish(f)).toMatchObject({ outcome: 'observed', counts: { legacy_receipts: 1 } });
  });

  it('replays committed sequences and refuses concurrent, future and scope-mismatched advances', async () => {
    const f = await fixture();
    f.start();
    const first = f.verifier.advance(f.id, scope, 0);
    expect(await f.verifier.advance(f.id, scope, 0)).toMatchObject({ outcome: 'busy', seq: 0 });
    const committed = await first;
    expect(await f.verifier.advance(f.id, scope, 0)).toEqual(committed);
    expect(f.state.receiptCalls).toBe(1);
    expect(() => f.verifier.status(f.id, { ...scope, workspace: 'foreign' })).toThrow(
      'scope denied',
    );
    expect(await f.verifier.advance(f.id, scope, committed.seq + 1)).toMatchObject({
      outcome: 'unknown',
      reasons: ['sequence_invalid'],
    });
  });

  it('treats eviction, midnight rollover and expired abandoned starts as unknown without restarting old sessions', async () => {
    const f = await fixture();
    f.start();
    const lost = new NativeBrowserArchiveVerifier(f.bindings);
    expect(lost.status(f.id, scope)).toMatchObject({
      outcome: 'unknown',
      reasons: ['session_lost'],
    });
    expect(lost.start(f.id, scope)).toMatchObject({
      outcome: 'unknown',
      reasons: ['session_lost'],
    });
    vi.setSystemTime(now + 31 * 60_000);
    const replacement = await fixture();
    expect(replacement.start()).toMatchObject({ outcome: 'running' });
    expect((f.verifier as unknown as { live: unknown }).live).toBeNull();
    expect(f.verifier.status(f.id, scope)).toMatchObject({
      outcome: 'unknown',
      counts: null,
      reasons: ['session_expired'],
    });
    vi.setSystemTime(now + 86_400_000);
    expect(replacement.verifier.status(replacement.id, scope)).toMatchObject({
      outcome: 'unknown',
      counts: null,
    });
  });

  it('retains admission while late native I/O remains and prevents late counters or commits', async () => {
    const f = await fixture();
    f.start();
    await until(f, 'bodies');
    let resolve!: (value: R2ObjectBody) => void;
    f.history.get.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const before = f.verifier.status(f.id, scope);
    const pending = f.verifier.advance(f.id, scope, before.seq);
    vi.setSystemTime(now + 31 * 60_000);
    expect(f.verifier.status(f.id, scope)).toMatchObject({
      outcome: 'unknown',
      reasons: ['session_expired'],
    });
    const blocked = await fixture();
    expect(blocked.start()).toMatchObject({ outcome: 'unknown', reasons: ['admission_busy'] });
    resolve(f.state.source.body());
    await pending;
    const next = await fixture();
    expect(next.start()).toMatchObject({ outcome: 'running' });
    expect((f.verifier as unknown as { live: unknown }).live).toBeNull();
    expect(f.verifier.status(f.id, scope)).toMatchObject({
      outcome: 'unknown',
      seq: before.seq,
      counts: null,
    });
  });

  it.each(['depth', 'nodes', 'bytes', 'batches'] as const)(
    'rejects selected %s overcap without rewriting facts',
    async (limit) => {
      const rows = [batch()];
      if (limit === 'depth') {
        let nested: unknown = 0;
        for (let i = 0; i < 17; i++) nested = { nested };
        rows[0]!.events[0]!.properties =
          nested as CollectedBrowserBatch['events'][number]['properties'];
      }
      if (limit === 'nodes')
        rows[0]!.events[0]!.properties = Array.from(
          { length: 8192 },
          () => 0,
        ) as unknown as CollectedBrowserBatch['events'][number]['properties'];
      if (limit === 'bytes') {
        rows.push(batch('bytes'));
        for (const row of rows) row.events[0]!.path = 'x'.repeat(33000);
      }
      if (limit === 'batches') rows.push(...Array.from({ length: 128 }, (_, i) => batch('b' + i)));
      const f = await fixture(rows);
      f.start();
      expect(await finish(f)).toMatchObject({ outcome: 'unknown', counts: null });
    },
  );
});

describe('native archive boundary guards', () => {
  it('fails closed on missing/malformed names and separates every reserved diagnostic name from producers', () => {
    expect(browserArchiveRole(undefined)).toBe('invalid');
    for (const name of [
      'w:browser-archive-v1:16',
      'w:browser-archive-v1:-1',
      'browser-native-audit-v1:bad',
      '',
    ])
      expect(browserArchiveRole(name)).toBe('invalid');
    for (let i = 0; i < 16; i++)
      expect(browserArchiveRole(`w:browser-archive-v1:${i}`)).toBe('producer');
    expect(browserArchiveRole(nativeArchiveDiagnosticName(crypto.randomUUID()))).toBe('diagnostic');
    expect(() => nativeArchiveDiagnosticName('invalid')).toThrow();
    expect(isNativeArchiveScope({ ...scope, day: '2026-11-16' }, now)).toBe(false);
    expect(isNativeArchiveScope({ ...scope, day: '2026-02-30' }, now)).toBe(false);
    expect(isNativeArchiveScope({ ...scope, workspace: '' }, now)).toBe(false);
  });

  it('rechecks full account-owner, allowed app, same origin, exact fields and current production ownership on every operation', async () => {
    const f = await fixture();
    const owner: OwnerIdentity = {
      id: 'owner',
      label: 'Owner',
      authKind: 'account',
      workspaceRole: 'owner',
      workspaceId: 'w',
      appIds: ['a'],
    };
    const env: BrowserEnvironment = {
      DB: f.bindings.DB,
      BROWSER_HISTORY: f.bindings.BROWSER_HISTORY as R2Bucket,
      BROWSER_ARCHIVE: {
        getByName: () => ({
          stage: async () => {
            throw new Error('producer');
          },
          lookupStaged: async () => {
            throw new Error('producer');
          },
          startNativeAudit: async (id, input) => f.verifier.start(id, input),
          nativeAuditStatus: async (id, input) => f.verifier.status(id, input),
          advanceNativeAudit: async (id, input, seq) => f.verifier.advance(id, input, seq),
        }),
      },
    };
    const request = (
      action = '',
      extra: Record<string, unknown> = {},
      origin = 'https://owner.test',
    ) =>
      new Request('https://owner.test/v1/browser/native-archive-audits' + action, {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify({ app_id: 'a', environment_id: 'e', day: scope.day, ...extra }),
      });
    for (const denied of [
      { workspaceRole: 'viewer' },
      { authKind: 'api-key' },
      { appId: 'a' },
      { apiScopes: [] },
      { apiPermission: 'read' },
    ])
      expect(
        (await handleBrowserOwner(request(), env, { ...owner, ...denied } as OwnerIdentity, false))!
          .status,
      ).toBe(403);
    expect(
      (await handleBrowserOwner(request('', {}, 'https://foreign.test'), env, owner, false))!
        .status,
    ).toBe(403);
    expect(
      (await handleBrowserOwner(request('', { prefix: 'forbidden' }), env, owner, false))!.status,
    ).toBe(400);
    expect(
      (await handleBrowserOwner(request(), env, { ...owner, appIds: [] }, false))!.status,
    ).toBe(404);
    const started = (await (await handleBrowserOwner(
      request(),
      env,
      owner,
      false,
    ))!.json()) as NativeArchiveResult;
    sessions.push({ verifier: f.verifier, id: started.session_id });
    expect(started).toMatchObject({ outcome: 'running', phase: 'receipt-initial', seq: 0 });
    for (const action of ['/status', '/advance']) {
      const extra = {
        session_id: started.session_id,
        ...(action === '/advance' ? { seq: 0 } : {}),
      };
      expect(
        (await handleBrowserOwner(request(action, extra), env, { ...owner, appIds: [] }, false))!
          .status,
      ).toBe(404);
      f.state.owned = false;
      expect((await handleBrowserOwner(request(action, extra), env, owner, false))!.status).toBe(
        404,
      );
      f.state.owned = true;
      expect(
        (await handleBrowserOwner(
          request(action, extra),
          env,
          { ...owner, workspaceRole: 'editor' },
          false,
        ))!.status,
      ).toBe(403);
      expect((await handleBrowserOwner(request(action, extra), env, owner, false))!.status).toBe(
        200,
      );
    }
  });
});
