import { ArchiveSegmentManifestV1, type ArchiveSegmentManifest } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import {
  isSafeBrowserArchiveDay,
  readBrowserArchiveAuditSegment,
} from './browser-archive-day-audit.js';
import { reconcileBrowserArchiveDay } from './browser-archive-reconciliation.js';
import { serializeBrowserEventFacts } from './browser-facts-digest.js';
import {
  readBrowserVisitorReceiptPage,
  type BrowserVisitorReceiptCursor,
  type BrowserVisitorReceiptPage,
} from './browser-visitor-daily.js';
import type { D1DatabaseLike } from './d1-adapter.js';

declare const __APP_HEALTH_BUILD_SHA__: string | undefined;

const DAY = 86_400_000;
const OFFSET = 19_800_000;
const MAX_STATE = 32 * 1024 * 1024;
const MAX_PLAIN = 768 * 1024;
const MAX_COMPRESSED = 512 * 1024;
const MAX_SELECTED_BYTES = 128 * 1024;
const MAX_NODES = 8192;
const MAX_BATCHES = 128;
const SESSION_MS = 30 * 60_000;
const SLICE_MS = 15_000;
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIAGNOSTIC_PREFIX = 'browser-native-audit-v1:';
const encoder = new TextEncoder();

// The capability can discard expired RAM only after I/O drains; it exposes no tenant data.
let isolatePermit: { token: symbol; reap: () => void } | null = null;

export type NativeArchiveScope = {
  workspace: string;
  app_id: string;
  environment_id: string;
  day: string;
};
type Receipt = BrowserVisitorReceiptPage['receipts'][number];
type Counts = {
  matched: number;
  mismatched: number;
  no_archive_candidate: number;
  legacy_receipts: number;
  archive_only_facts: number;
  duplicate_archive_candidates: number;
  missing_archive_digests: number;
};
type Phase =
  | 'receipt-initial'
  | 'metadata-A'
  | 'bodies'
  | 'classify'
  | 'metadata-B'
  | 'compare'
  | 'receipt-final'
  | 'terminal';
export type NativeArchiveResult = {
  session_id: string;
  phase: Phase;
  seq: number;
  outcome: 'running' | 'busy' | 'observed' | 'unknown';
  complete: false;
  inner_execution_sha: string | null;
  counts: Counts | null;
  reasons: string[];
};
export type NativeArchiveBindings = {
  DB?: D1DatabaseLike;
  BROWSER_HISTORY: Pick<R2Bucket, 'get' | 'list'>;
};
type Candidate = {
  key: string;
  size: number;
  manifest: ArchiveSegmentManifest;
  fingerprint: string;
};
type Listing = {
  prefix: number;
  cursor?: string;
  pages: number;
  keys: number;
  bytes: number;
  candidates: number;
  seen: Set<string>;
  seenBytes: number;
};
type Facts = { batches: CollectedBrowserBatch[]; nodes: number; bytes: number };
type Live = {
  scope: NativeArchiveScope;
  id: string;
  captureDay: string;
  expires: number;
  prefixes: string[];
  phase: Exclude<Phase, 'terminal'>;
  seq: number;
  initial: Receipt[];
  receiptCursor?: BrowserVisitorReceiptCursor;
  receiptPages: number;
  receiptBytes: number;
  finalOffset: number;
  candidates: Map<string, Candidate>;
  candidateBytes: number;
  compressed: number;
  plain: number;
  listing: Listing;
  metadataPages: number;
  candidateKeys: string[];
  bodyOffset: number;
  pending?: { batches: CollectedBrowserBatch[]; offset: number; bytes: number };
  facts: Facts;
  counts?: Counts;
};
type Step = () => void;

export function nativeArchiveExecutionSHA(): string | null {
  return typeof __APP_HEALTH_BUILD_SHA__ === 'string' &&
    /^[a-f0-9]{40}$/.test(__APP_HEALTH_BUILD_SHA__)
    ? __APP_HEALTH_BUILD_SHA__
    : null;
}

export function nativeArchiveDiagnosticName(id: string): string {
  if (!SESSION_ID.test(id)) throw new Error('Invalid native archive session');
  return DIAGNOSTIC_PREFIX + id;
}

export function browserArchiveRole(name: unknown): 'producer' | 'diagnostic' | 'invalid' {
  if (typeof name !== 'string') return 'invalid';
  if (name.startsWith(DIAGNOSTIC_PREFIX) && SESSION_ID.test(name.slice(DIAGNOSTIC_PREFIX.length)))
    return 'diagnostic';
  return /^.{1,100}:browser-archive-v1:(?:[0-9]|1[0-5])$/.test(name) ? 'producer' : 'invalid';
}

export function isNativeArchiveScope(scope: NativeArchiveScope, now = Date.now()): boolean {
  if (
    [scope.workspace, scope.app_id, scope.environment_id].some(
      (x) => typeof x !== 'string' || !x || x.length > 100,
    ) ||
    !isSafeBrowserArchiveDay(scope.day)
  )
    return false;
  const end = Date.parse(scope.day + 'T00:00:00Z') - OFFSET + DAY;
  return now >= end + DAY + 60_000 && now - end <= 34 * DAY;
}

function emptyListing(): Listing {
  return { prefix: 0, pages: 0, keys: 0, bytes: 0, candidates: 0, seen: new Set(), seenBytes: 0 };
}

function prefixPlan(scope: NativeArchiveScope, now: number): string[] {
  const first = Math.floor((Date.parse(scope.day + 'T00:00:00Z') - OFFSET - 60_000) / DAY) * DAY;
  const last = Math.floor(now / DAY) * DAY;
  const prefixes: string[] = [];
  for (let at = first; at <= last; at += DAY)
    prefixes.push(
      'browser-v2/' + new Date(at).toISOString().slice(0, 10).replaceAll('-', '/') + '/',
    );
  if (prefixes.length > 36) throw new Error('prefix_cap');
  return prefixes;
}

function scopeEqual(a: NativeArchiveScope, b: NativeArchiveScope): boolean {
  return (
    a.workspace === b.workspace &&
    a.app_id === b.app_id &&
    a.environment_id === b.environment_id &&
    a.day === b.day
  );
}

function candidateFor(scope: NativeArchiveScope, m: ArchiveSegmentManifest): boolean {
  const from = Date.parse(scope.day + 'T00:00:00Z') - OFFSET;
  return (
    m.workspace_id === scope.workspace && m.min_event_at < from + DAY && m.max_event_at >= from
  );
}

function parseMetadata(row: R2Object, prefix: string): Candidate {
  const text = row.customMetadata?.manifest;
  if (
    typeof row.key !== 'string' ||
    row.key.length > 1024 ||
    !row.key.startsWith(prefix) ||
    !/^browser-v2\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9]{64}\/[a-f0-9-]{36}\.jsonl\.gz$/.test(row.key) ||
    !text ||
    text.length > 8192
  )
    throw new Error('metadata_invalid');
  const parsed = ArchiveSegmentManifestV1.safeParse(JSON.parse(text));
  if (
    !parsed.success ||
    parsed.data.object_key !== row.key ||
    parsed.data.compressed_bytes !== row.size
  )
    throw new Error('metadata_invalid');
  return {
    key: row.key,
    size: row.size,
    manifest: parsed.data,
    fingerprint: JSON.stringify(parsed.data),
  };
}

function receiptKey(row: BrowserVisitorReceiptCursor): string {
  return JSON.stringify([row.app_id, row.environment_id, row.batch_id]);
}

function nullableInteger(value: number | null, min = 0, max = Number.MAX_SAFE_INTEGER): boolean {
  return value === null || (Number.isSafeInteger(value) && value >= min && value <= max);
}

function validReceipt(row: Receipt, scope: NativeArchiveScope): boolean {
  const strings = [
    row.batch_id,
    row.fingerprint,
    ...(row.facts_digest === null ? [] : [row.facts_digest]),
  ];
  return (
    row.app_id === scope.app_id &&
    row.environment_id === scope.environment_id &&
    strings.every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 200,
    ) &&
    nullableInteger(row.accepted_at) &&
    nullableInteger(row.event_count, 1, 25) &&
    nullableInteger(row.facts_digest_version)
  );
}

function validateReceipts(page: BrowserVisitorReceiptPage, live: Live): number {
  if (!Array.isArray(page.receipts) || page.receipts.length > 64 || live.receiptPages >= 8)
    throw new Error('receipt_cap');
  let last = live.receiptCursor;
  for (const row of page.receipts) {
    if (!validReceipt(row, live.scope)) throw new Error('receipt_invalid');
    if (last && row.batch_id <= last.batch_id) throw new Error('receipt_cursor');
    last = row;
  }
  if (
    page.next_cursor !== null &&
    (!last || !page.receipts.length || receiptKey(page.next_cursor) !== receiptKey(last))
  )
    throw new Error('receipt_cursor');
  return encoder.encode(JSON.stringify(page.receipts)).byteLength;
}

function selectedResources(batch: CollectedBrowserBatch): { nodes: number; bytes: number } {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: batch, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 16 || ++nodes > MAX_NODES) throw new Error('selected_structure_cap');
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (++nodes > MAX_NODES || key.length > MAX_SELECTED_BYTES)
          throw new Error('selected_structure_cap');
        stack.push({ value: item, depth: depth + 1 });
      }
    }
  }
  const raw = encoder.encode(JSON.stringify(batch)).byteLength;
  const canonical = encoder.encode(serializeBrowserEventFacts(batch)).byteLength;
  if (raw > 65536 || canonical > 65536) throw new Error('selected_byte_cap');
  return { nodes, bytes: raw + canonical };
}

function stateBytes(live: Live): number {
  return (
    live.listing.seenBytes +
    live.candidateBytes +
    live.receiptBytes * 4 +
    live.facts.bytes * 4 +
    live.facts.nodes * 96 +
    (live.pending?.bytes ?? 0) * 8 +
    128 * 1024
  );
}

function aggregate(rows: readonly { state: string }[]): Counts {
  const counts: Counts = {
    matched: 0,
    mismatched: 0,
    no_archive_candidate: 0,
    legacy_receipts: 0,
    archive_only_facts: 0,
    duplicate_archive_candidates: 0,
    missing_archive_digests: 0,
  };
  const names: Record<string, keyof Counts> = {
    matched: 'matched',
    digest_mismatch: 'mismatched',
    missing_archive_fact: 'no_archive_candidate',
    legacy_receipt: 'legacy_receipts',
    archive_without_d1_receipt: 'archive_only_facts',
    duplicate_archive_fact: 'duplicate_archive_candidates',
    archive_digest_missing: 'missing_archive_digests',
  };
  for (const row of rows) counts[names[row.state]!]++;
  return counts;
}

export class NativeBrowserArchiveVerifier {
  private live: Live | null = null;
  private result: NativeArchiveResult | null = null;
  private scope: NativeArchiveScope | null = null;
  private sessionId: string | null = null;
  private permit: symbol | null = null;
  private active: symbol | null = null;
  private pendingIO = 0;
  private replay: { seq: number; result: NativeArchiveResult } | null = null;

  constructor(private readonly env: NativeArchiveBindings) {}

  start(id: string, scope: NativeArchiveScope): NativeArchiveResult {
    if (!SESSION_ID.test(id) || !isNativeArchiveScope(scope))
      throw new Error('Invalid native archive scope');
    if (this.scope) return this.status(id, scope);
    this.scope = { ...scope };
    this.sessionId = id;
    isolatePermit?.reap();
    if (isolatePermit !== null) return this.unknown(id, 0, 'admission_busy');
    this.permit = Symbol();
    isolatePermit = {
      token: this.permit,
      reap: () => {
        if (this.live && !this.current(this.live) && this.pendingIO === 0)
          this.unknown(this.live.id, this.live.seq, 'session_expired');
      },
    };
    const now = Date.now();
    this.live = {
      scope: { ...scope },
      id,
      captureDay: new Date(now).toISOString().slice(0, 10),
      expires: now + SESSION_MS,
      prefixes: prefixPlan(scope, now),
      phase: 'receipt-initial',
      seq: 0,
      initial: [],
      receiptPages: 0,
      receiptBytes: 0,
      finalOffset: 0,
      candidates: new Map(),
      candidateBytes: 0,
      compressed: 0,
      plain: 0,
      listing: emptyListing(),
      metadataPages: 0,
      candidateKeys: [],
      bodyOffset: 0,
      facts: { batches: [], nodes: 0, bytes: 0 },
    };
    return this.view(this.live);
  }

  status(id: string, scope: NativeArchiveScope): NativeArchiveResult {
    this.assertScope(id, scope);
    if (this.live && !this.current(this.live))
      return this.unknown(id, this.live.seq, 'session_expired');
    return (
      this.result ??
      (this.live
        ? this.view(this.live, this.active ? 'busy' : 'running')
        : this.unknown(id, 0, 'session_lost'))
    );
  }

  async advance(id: string, scope: NativeArchiveScope, seq: number): Promise<NativeArchiveResult> {
    this.assertScope(id, scope);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid native archive sequence');
    const status = this.status(id, scope);
    if (!this.live || this.result) return status;
    if (this.active) return this.view(this.live, 'busy');
    if (this.replay?.seq === seq) return this.replay.result;
    const live = this.live;
    if (seq !== live.seq || seq >= 4096) return this.unknown(id, live.seq, 'sequence_invalid');
    const reservation = Symbol();
    this.active = reservation;
    this.pendingIO++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (this.active !== reservation || this.live !== live || !this.current(live))
        throw new Error('session_expired');
    };
    const work = (async () => {
      try {
        const commit = await this.step(live, check);
        check();
        commit();
        if (stateBytes(live) > MAX_STATE) throw new Error('state_cap');
        live.seq++;
        if (live.phase === 'receipt-final' && live.finalOffset < 0) {
          this.result = {
            ...this.view(live),
            phase: 'terminal',
            outcome: 'observed',
            counts: live.counts!,
            reasons: [
              'd1_retention_unknown',
              'r2_retention_unknown',
              'queue_unknown',
              'dlq_unknown',
            ],
          };
          this.live = null;
        }
        const result = this.result ?? this.view(live);
        this.replay = { seq, result };
        return result;
      } catch (error) {
        const reason =
          error instanceof Error && REASONS.has(error.message)
            ? error.message
            : 'source_unavailable';
        return this.unknown(id, live.seq, reason);
      } finally {
        this.pendingIO--;
        if (this.active === reservation) this.active = null;
        this.release();
      }
    })();
    try {
      return await Promise.race([
        work,
        new Promise<NativeArchiveResult>((resolve) => {
          timer = setTimeout(() => resolve(this.unknown(id, live.seq, 'slice_timeout')), SLICE_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertScope(id: string, scope: NativeArchiveScope): void {
    if (!SESSION_ID.test(id)) throw new Error('Native archive scope denied');
    if (!this.scope) {
      this.scope = { ...scope };
      this.sessionId = id;
    }
    if (!scopeEqual(this.scope, scope) || this.sessionId !== id)
      throw new Error('Native archive scope denied');
  }

  private current(live: Live): boolean {
    return Date.now() < live.expires && new Date().toISOString().slice(0, 10) === live.captureDay;
  }

  private view(live: Live, outcome: 'running' | 'busy' = 'running'): NativeArchiveResult {
    return {
      session_id: live.id,
      phase: live.phase,
      seq: live.seq,
      outcome,
      complete: false,
      inner_execution_sha: nativeArchiveExecutionSHA(),
      counts: null,
      reasons: [],
    };
  }

  private unknown(id: string, seq: number, reason: string): NativeArchiveResult {
    if (this.result) return this.result;
    this.result = {
      session_id: id,
      phase: 'terminal',
      seq,
      outcome: 'unknown',
      complete: false,
      inner_execution_sha: nativeArchiveExecutionSHA(),
      counts: null,
      reasons: [reason],
    };
    this.live = null;
    this.active = null;
    this.replay = null;
    this.release();
    return this.result;
  }

  private release(): void {
    if (this.live || this.pendingIO || !this.permit) return;
    if (isolatePermit?.token === this.permit) isolatePermit = null;
    this.permit = null;
  }

  private async step(live: Live, check: () => void): Promise<Step> {
    switch (live.phase) {
      case 'receipt-initial':
      case 'receipt-final':
        return this.receiptStep(live, check);
      case 'metadata-A':
      case 'metadata-B':
        return this.metadataStep(live, check);
      case 'bodies':
        return this.bodyStep(live, check);
      case 'classify':
        return this.classifyStep(live);
      case 'compare': {
        const comparison = await reconcileBrowserArchiveDay({
          day: live.scope.day,
          workspace: live.scope.workspace,
          receipts: live.initial,
          archived: live.facts.batches,
          receipt_pages_complete: true,
          archive_lookup_complete: true,
          d1_retention: 'unknown',
          r2_retention: 'unknown',
          queue: 'unknown',
          dlq: 'unknown',
        });
        check();
        const counts = aggregate(comparison.rows);
        return () => {
          live.counts = counts;
          live.facts = { batches: [], nodes: 0, bytes: 0 };
          live.initial = live.initial.slice();
          live.phase = 'receipt-final';
          live.receiptCursor = undefined;
          live.receiptPages = 0;
        };
      }
    }
  }

  private async receiptStep(live: Live, check: () => void): Promise<Step> {
    if (!this.env.DB) throw new Error('source_unavailable');
    const page = await readBrowserVisitorReceiptPage(
      this.env.DB,
      live.scope.workspace,
      [live.scope],
      live.scope.day,
      64,
      live.receiptCursor,
    );
    check();
    const bytes = validateReceipts(page, live);
    const final = live.phase === 'receipt-final';
    const count = final ? live.finalOffset : live.initial.length;
    if (count + page.receipts.length > MAX_BATCHES || live.receiptBytes + bytes > 256 * 1024)
      throw new Error('receipt_cap');
    if (
      final &&
      page.receipts.some(
        (row, index) => JSON.stringify(row) !== JSON.stringify(live.initial[count + index]),
      )
    )
      throw new Error('receipt_changed');
    if (final && page.next_cursor === null && count + page.receipts.length !== live.initial.length)
      throw new Error('receipt_changed');
    return () => {
      live.receiptPages++;
      live.receiptBytes += bytes;
      live.receiptCursor = page.next_cursor ?? undefined;
      if (final) live.finalOffset = page.next_cursor === null ? -1 : count + page.receipts.length;
      else {
        live.initial.push(...page.receipts.map((row) => ({ ...row })));
        if (page.next_cursor === null) {
          live.phase = 'metadata-A';
          live.receiptCursor = undefined;
        }
      }
    };
  }

  private async metadataStep(live: Live, check: () => void): Promise<Step> {
    const listing = live.listing;
    if (live.metadataPages >= 512) throw new Error('metadata_page_cap');
    const prefix = live.prefixes[listing.prefix]!;
    const page = await this.env.BROWSER_HISTORY.list({
      prefix,
      cursor: listing.cursor,
      limit: 256,
      include: ['customMetadata'],
    });
    check();
    if (
      typeof page.truncated !== 'boolean' ||
      !Array.isArray(page.objects) ||
      page.objects.length > 256 ||
      (page.truncated &&
        (typeof page.cursor !== 'string' ||
          !page.cursor ||
          page.cursor.length > 8192 ||
          page.cursor === listing.cursor))
    )
      throw new Error('metadata_cursor');
    const rows: Candidate[] = [];
    const seen = new Set<string>();
    let bytes = 0,
      seenBytes = 0,
      candidateBytes = 0,
      compressed = 0,
      plain = 0;
    for (const row of page.objects) {
      const candidate = parseMetadata(row, prefix);
      if (listing.seen.has(candidate.key) || seen.has(candidate.key))
        throw new Error('metadata_duplicate');
      seen.add(candidate.key);
      bytes += encoder.encode(candidate.key + row.customMetadata!.manifest).byteLength;
      seenBytes += candidate.key.length * 2 + 192;
      if (!candidateFor(live.scope, candidate.manifest)) continue;
      if (candidate.manifest.state !== 'active' || candidate.manifest.format !== 'jsonl-gzip')
        throw new Error('candidate_unsupported');
      rows.push(candidate);
      candidateBytes += candidate.key.length * 2 + candidate.fingerprint.length * 4 + 1024;
      compressed += candidate.size;
      plain += candidate.manifest.uncompressed_bytes;
      if (candidate.manifest.row_count > 4096) throw new Error('candidate_cap');
      if (
        live.phase === 'metadata-B' &&
        live.candidates.get(candidate.key)?.fingerprint !== candidate.fingerprint
      )
        throw new Error('candidate_changed');
    }
    if (
      listing.keys + seen.size > 20_000 ||
      listing.bytes + bytes > 32 * 1024 * 1024 ||
      listing.candidates + rows.length > 1000
    )
      throw new Error('metadata_cap');
    if (
      live.phase === 'metadata-A' &&
      (live.compressed + compressed > MAX_COMPRESSED || live.plain + plain > MAX_PLAIN)
    )
      throw new Error('candidate_byte_cap');
    if (
      stateBytes(live) + seenBytes + (live.phase === 'metadata-A' ? candidateBytes : 0) >
      MAX_STATE
    )
      throw new Error('state_cap');
    const finished = !page.truncated && listing.prefix + 1 === live.prefixes.length;
    if (
      finished &&
      live.phase === 'metadata-B' &&
      listing.candidates + rows.length !== live.candidates.size
    )
      throw new Error('candidate_changed');
    return () => {
      live.metadataPages++;
      listing.pages++;
      listing.keys += seen.size;
      listing.bytes += bytes;
      listing.seenBytes += seenBytes;
      listing.candidates += rows.length;
      for (const key of seen) listing.seen.add(key);
      if (live.phase === 'metadata-A') {
        for (const row of rows) {
          live.candidates.set(row.key, row);
          live.candidateKeys.push(row.key);
        }
        live.candidateBytes += candidateBytes;
        live.compressed += compressed;
        live.plain += plain;
      }
      if (page.truncated) listing.cursor = page.cursor;
      else {
        listing.prefix++;
        listing.cursor = undefined;
      }
      if (finished) {
        live.listing = emptyListing();
        if (live.phase === 'metadata-A') {
          live.phase = 'bodies';
        } else {
          live.phase = 'compare';
          live.candidates = new Map();
          live.candidateBytes = 0;
        }
      }
    };
  }

  private async bodyStep(live: Live, check: () => void): Promise<Step> {
    const key = live.candidateKeys[live.bodyOffset];
    if (key === undefined)
      return () => {
        live.phase = 'metadata-B';
        live.candidateKeys = [];
      };
    const candidate = live.candidates.get(key)!;
    let consumed = false;
    const history = {
      get: async () => {
        if (consumed) throw new Error('candidate_changed');
        consumed = true;
        const object = await this.env.BROWSER_HISTORY.get(candidate.key);
        try {
          check();
          if (
            !object ||
            object.key !== candidate.key ||
            object.size !== candidate.size ||
            parseMetadata(
              object,
              live.prefixes.find((prefix) => candidate.key.startsWith(prefix))!,
            ).fingerprint !== candidate.fingerprint
          )
            throw new Error('candidate_changed');
          return object;
        } catch (error) {
          if (object) await object.body.cancel().catch(() => undefined);
          throw error;
        }
      },
    };
    const result = await readBrowserArchiveAuditSegment(
      { workspace: live.scope.workspace, history: history as Pick<R2Bucket, 'get'> },
      { segment_id: 'native', object_key: candidate.key },
      { compressed: 0, decompressed: 0 },
    );
    check();
    return () => {
      live.bodyOffset++;
      live.pending = {
        batches: result.batches,
        offset: 0,
        bytes: candidate.manifest.uncompressed_bytes,
      };
      live.phase = 'classify';
    };
  }

  private classifyStep(live: Live): Step {
    const pending = live.pending!;
    const selected: CollectedBrowserBatch[] = [];
    let nodes = 0,
      bytes = 0;
    const end = Math.min(pending.offset + 32, pending.batches.length);
    for (let index = pending.offset; index < end; index++) {
      const batch = pending.batches[index]!;
      if (batch.app_id !== live.scope.app_id || batch.environment_id !== live.scope.environment_id)
        continue;
      const resources = selectedResources(batch);
      nodes += resources.nodes;
      bytes += resources.bytes;
      selected.push(batch);
      if (
        live.facts.batches.length + selected.length > MAX_BATCHES ||
        live.facts.nodes + nodes > MAX_NODES ||
        live.facts.bytes + bytes > MAX_SELECTED_BYTES
      )
        throw new Error('selected_cap');
    }
    return () => {
      live.facts.batches.push(...selected);
      live.facts.nodes += nodes;
      live.facts.bytes += bytes;
      pending.offset = end;
      if (end === pending.batches.length) {
        live.pending = undefined;
        live.phase = 'bodies';
      }
    };
  }
}

const REASONS = new Set([
  'admission_busy',
  'session_expired',
  'session_lost',
  'sequence_invalid',
  'slice_timeout',
  'state_cap',
  'receipt_cap',
  'receipt_invalid',
  'receipt_cursor',
  'receipt_changed',
  'metadata_invalid',
  'metadata_cursor',
  'metadata_duplicate',
  'metadata_cap',
  'metadata_page_cap',
  'candidate_unsupported',
  'candidate_cap',
  'candidate_changed',
  'candidate_byte_cap',
  'selected_structure_cap',
  'selected_byte_cap',
  'selected_cap',
  'source_unavailable',
]);
