import type { D1DatabaseLike, D1PreparedStatement } from './d1-adapter.js';
import { endpointReadRanges } from './endpoint-read-ranges.js';
import {
  readEndpointColdArchiveRows,
  type EndpointColdArchiveManifest,
  type EndpointRollupColdRow,
} from './endpoint-cold-archive.js';
import { ENDPOINT_MINUTE_HOT_DAYS } from './endpoint-compaction.js';

const MAX_OBJECTS = 128;
const MAX_ROWS = 20_000;
const MAX_BYTES = 16 * 1024 * 1024;
type Scope = { app_id: string; environment_id: string };
type Range = { from: number; to: number; resolution: number };

async function hasArchiveTable(db: D1DatabaseLike) {
  const table = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'endpoint_cold_archives'",
    )
    .first();
  return Boolean(table);
}

function manifestStatement(db: D1DatabaseLike, scopes: readonly Scope[], ranges: readonly Range[]) {
  return db
    .prepare(
      `SELECT DISTINCT m.* FROM endpoint_cold_archives m
    JOIN json_each(?) s ON m.app_id = json_extract(s.value, '$.app_id')
      AND m.environment_id = json_extract(s.value, '$.environment_id')
    JOIN json_each(?) q ON m.resolution_ms = json_extract(q.value, '$.resolution')
      AND m.bucket_from < json_extract(q.value, '$.to')
      AND m.bucket_to > json_extract(q.value, '$.from')
    WHERE m.source_removed_at IS NOT NULL ORDER BY m.object_key LIMIT ${MAX_OBJECTS + 1}`,
    )
    .bind(JSON.stringify(scopes), JSON.stringify(ranges));
}

function scopeKey(scope: Scope) {
  return `${scope.app_id}\0${scope.environment_id}`;
}
function selected(row: EndpointRollupColdRow, scopes: Set<string>, ranges: readonly Range[]) {
  return (
    scopes.has(scopeKey(row)) &&
    ranges.some(
      (range) =>
        row.resolution_ms === range.resolution &&
        row.bucket_start >= range.from &&
        row.bucket_start < range.to,
    )
  );
}

/** Current reads never touch R2. Retired history is read once, within fixed caps. */
export async function readEndpointHistory<T extends Record<string, unknown>>(args: {
  db: D1DatabaseLike;
  bucket?: Pick<R2Bucket, 'get'>;
  scopes: readonly Scope[];
  from: number;
  to: number;
  now: number;
  hot: D1PreparedStatement;
}): Promise<{ hotRows: T[]; coldRows: EndpointRollupColdRow[] }> {
  validateQuery(args);
  if (args.from >= args.now - ENDPOINT_MINUTE_HOT_DAYS * 86_400_000 || !args.scopes.length)
    return { hotRows: (await args.hot.all<T>()).results, coldRows: [] };
  if (args.scopes.length > 128) throw new Error('Endpoint cold query exceeds scope bound');
  const ranges = endpointReadRanges(args.from, args.to);
  if (!(await hasArchiveTable(args.db)))
    return { hotRows: (await args.hot.all<T>()).results, coldRows: [] };
  // Both SELECTs share a transaction snapshot. Retirement cannot split this read.
  const results = await args.db.batch([args.hot, manifestStatement(args.db, args.scopes, ranges)]);
  if (
    results.length !== 2 ||
    results.some((result) => !result.success || !Array.isArray(result.results))
  )
    throw new Error('Endpoint history snapshot failed');
  const hotRows = results[0].results as T[];
  const archives = results[1].results as EndpointColdArchiveManifest[];
  if (archives.length > MAX_OBJECTS) throw new Error('Endpoint cold query exceeds object bound');
  if (!archives.length) return { hotRows, coldRows: [] };
  const coldRows = await readArchivesWithinBudget(args, archives, ranges);
  return { hotRows, coldRows };
}

function validateQuery(args: { from: number; to: number; now: number; scopes: readonly Scope[] }) {
  if (
    ![args.from, args.to, args.now].every(Number.isSafeInteger) ||
    args.from < 0 ||
    args.to <= args.from ||
    args.from % 60_000 ||
    args.to % 60_000
  )
    throw new Error('Invalid endpoint history query');
  if (
    args.scopes.some(
      (scope) =>
        !scope.app_id ||
        !scope.environment_id ||
        scope.app_id.length > 200 ||
        scope.environment_id.length > 200,
    )
  )
    throw new Error('Invalid endpoint history scope');
}

async function readArchives(
  args: { bucket?: Pick<R2Bucket, 'get'>; scopes: readonly Scope[] },
  archives: EndpointColdArchiveManifest[],
  ranges: readonly Range[],
  deadline: number,
): Promise<EndpointRollupColdRow[]> {
  if (!args.bucket) throw new Error('Endpoint cold history is unavailable');
  const bytes = archives.reduce((sum, manifest) => sum + manifest.uncompressed_bytes, 0);
  if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES)
    throw new Error('Endpoint cold query exceeds byte bound');
  const scopeSet = new Set(args.scopes.map(scopeKey));
  const rows: EndpointRollupColdRow[] = [];
  for (let offset = 0; offset < archives.length; offset += 4) {
    if (performance.now() >= deadline) throw new Error('Endpoint cold query time budget exceeded');
    const group = await Promise.all(
      archives
        .slice(offset, offset + 4)
        .map((manifest) => readEndpointColdArchiveRows(args.bucket!, manifest)),
    );
    for (const partition of group)
      rows.push(...partition.filter((row) => selected(row, scopeSet, ranges)));
    if (rows.length > MAX_ROWS) throw new Error('Endpoint cold query exceeds row bound');
  }
  return rows;
}

async function readArchivesWithinBudget(
  args: { bucket?: Pick<R2Bucket, 'get'>; scopes: readonly Scope[] },
  archives: EndpointColdArchiveManifest[],
  ranges: readonly Range[],
) {
  const budget = 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Endpoint cold query time budget exceeded')), budget);
  });
  try {
    return await Promise.race([
      readArchives(args, archives, ranges, performance.now() + budget),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
