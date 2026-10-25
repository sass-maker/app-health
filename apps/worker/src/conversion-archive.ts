import type { AnalysisQuery } from '@app-health/contracts';
import type { BrowserEnvironment } from './browser-routes.js';
import type { CollectedBrowserBatch } from './browser-analytics.js';
import type { ArchiveScopeCursor, ArchiveScopeWindow } from './browser-archive.js';
import { readBrowserArchiveAuditSegment } from './browser-archive-day-audit.js';

const DAY_MS = 86400000;
type Reference = { segment_id: string; object_key: string };

async function shardReferences(
  archive: NonNullable<BrowserEnvironment['BROWSER_ARCHIVE']>,
  name: string,
  scope: ArchiveScopeWindow,
  deadline: number,
) {
  const shard = archive.getByName(name);
  if (!shard.archiveSegmentsForScope) throw new Error('Archive scope index unavailable');
  let cursor: ArchiveScopeCursor | null = null;
  const refs: Reference[] = [];
  do {
    if (performance.now() > deadline || refs.length >= 200)
      throw new Error('Conversion scan limit exceeded; choose a shorter period.');
    const page = await shard.archiveSegmentsForScope(scope, cursor, 100);
    refs.push(...page.segments);
    if (page.next_cursor && page.next_cursor.object_key <= (cursor?.object_key ?? ''))
      throw new Error('Archive cursor did not advance');
    cursor = page.next_cursor;
  } while (cursor);
  return refs;
}

async function windowReferences(
  archive: NonNullable<BrowserEnvironment['BROWSER_ARCHIVE']>,
  workspace: string,
  scope: ArchiveScopeWindow,
  deadline: number,
) {
  const references = new Map<string, Reference>();
  for (let base = 0; base < 16; base += 4) {
    const pages = await Promise.all(
      Array.from({ length: 4 }, (_, offset) =>
        shardReferences(
          archive,
          `${workspace}:browser-archive-v1:${base + offset}`,
          scope,
          deadline,
        ),
      ),
    );
    for (const refs of pages) for (const ref of refs) references.set(ref.object_key, ref);
    if (references.size > 200) throw new Error('Conversion segment limit exceeded.');
  }
  return references;
}

/** Bounded, manifest-verified archive read. It does not establish queue/source completeness. */
export async function readConversionArchive(
  env: BrowserEnvironment,
  workspace: string,
  query: AnalysisQuery,
  from: number,
  to: number,
  budget?: { objects: number; bytes: number },
): Promise<CollectedBrowserBatch[]> {
  const { BROWSER_ARCHIVE: archive, BROWSER_HISTORY: history } = env;
  if (!archive || !history?.get) throw new Error('Conversion archive unavailable');
  if (to <= from || to - from > 30 * DAY_MS) throw new Error('Invalid conversion period');
  const get = history.get.bind(history);
  const deadline = performance.now() + 15000;
  const references = await windowReferences(
    archive,
    workspace,
    { app_id: query.app_id, environment_id: query.environment_id, from, to },
    deadline,
  );
  if (budget) {
    budget.objects += references.size;
    if (budget.objects > 200) throw new Error('Combined conversion segment limit exceeded');
  }
  const batches: CollectedBrowserBatch[] = [];
  const bytes = { compressed: 0, decompressed: 0 };
  let events = 0;
  for (const reference of references.values()) {
    if (performance.now() > deadline)
      throw new Error('Conversion scan time limit exceeded; choose a shorter period.');
    // This reader checks the gzip hash, manifest, workspace, lengths and row bounds.
    const result = await readBrowserArchiveAuditSegment(
      { workspace, history: { get } },
      reference,
      bytes,
    );
    for (const batch of result.batches) {
      if (batch.app_id !== query.app_id || batch.environment_id !== query.environment_id) continue;
      const scoped = batch.events.filter(
        (event) => event.timestamp >= from && event.timestamp < to,
      );
      events += scoped.length;
      if (events > 50000)
        throw new Error('Conversion event limit exceeded; choose a shorter period.');
      if (scoped.length) batches.push({ ...batch, events: scoped });
    }
  }
  if (budget) budget.bytes += bytes.decompressed;
  return batches;
}
