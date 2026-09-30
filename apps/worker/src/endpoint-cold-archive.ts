import {
  LATENCY_HISTOGRAM_BUCKETS,
  MAX_METHOD_LENGTH,
  MAX_RELEASE_LENGTH,
  MAX_ROUTE_LENGTH,
  RUNTIMES,
  latencyHistogramSchemaFromBounds,
  type Runtime,
} from '@app-health/contracts';
import type { D1DatabaseLike } from './d1-adapter.js';

const ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION = 1 as const;
export const MAX_ENDPOINT_COLD_ARCHIVE_ROWS = 10_000;
const MAX_ENDPOINT_COLD_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES = 4 * 1024 * 1024;

const ENDPOINT_RESOLUTIONS = [60_000, 3_600_000, 86_400_000] as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
export const ENDPOINT_COLD_ROW_COLUMNS = Object.freeze(
  [
    'app_id',
    'environment_id',
    'resolution_ms',
    'bucket_start',
    'method',
    'route',
    'runtime',
    'release',
    'histogram_bounds_ms',
    'request_count',
    'error_count',
    'duration_sum_ms',
    'response_bytes_sum',
    'response_bytes_measured',
    'last_seen',
    'upstream_sampled',
    ...Array.from({ length: LATENCY_HISTOGRAM_BUCKETS }, (_, index) => `h${index}`),
  ].sort(),
);
const ROW_KEYS = ENDPOINT_COLD_ROW_COLUMNS;

export type EndpointRollupColdRow = {
  app_id: string;
  environment_id: string;
  resolution_ms: (typeof ENDPOINT_RESOLUTIONS)[number];
  bucket_start: number;
  method: string;
  route: string;
  runtime: Runtime;
  release: string;
  histogram_bounds_ms: string;
  request_count: number;
  error_count: number;
  duration_sum_ms: number;
  response_bytes_sum: number;
  response_bytes_measured: number;
  last_seen: number;
  upstream_sampled: 0 | 1;
} & Record<`h${number}`, number>;

export type EndpointColdArchiveRange = {
  app_id: string;
  environment_id: string;
  resolution_ms: (typeof ENDPOINT_RESOLUTIONS)[number];
  bucket_from: number;
  bucket_to: number;
};

export type EndpointColdArchiveManifest = EndpointColdArchiveRange & {
  object_key: string;
  content_sha256: string;
  row_count: number;
  uncompressed_bytes: number;
  compressed_bytes: number;
  schema_version: typeof ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION;
  completed_at: number;
  /** NULL until a separate verified compare-and-delete retires the hot snapshot. */
  source_removed_at: number | null;
};

type EndpointColdArchiveBucket = Pick<R2Bucket, 'put' | 'get'>;
type EndpointColdArchiveReader = Pick<R2Bucket, 'get'>;

type ArchiveEnvelope = {
  format: 'app-health-endpoint-rollups';
  schema_version: typeof ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION;
  range: EndpointColdArchiveRange;
  rows: EndpointRollupColdRow[];
};

function validIdentifier(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function validRange(range: EndpointColdArchiveRange): void {
  if (
    !validIdentifier(range.app_id) ||
    !validIdentifier(range.environment_id) ||
    !ENDPOINT_RESOLUTIONS.includes(range.resolution_ms) ||
    !Number.isSafeInteger(range.bucket_from) ||
    !Number.isSafeInteger(range.bucket_to) ||
    range.bucket_from < 0 ||
    range.bucket_to <= range.bucket_from ||
    range.bucket_from % range.resolution_ms !== 0 ||
    range.bucket_to % range.resolution_ms !== 0
  )
    throw new Error('Invalid endpoint cold archive range');
}

function canonicalRange(range: EndpointColdArchiveRange): EndpointColdArchiveRange {
  return {
    app_id: range.app_id,
    environment_id: range.environment_id,
    resolution_ms: range.resolution_ms,
    bucket_from: range.bucket_from,
    bucket_to: range.bucket_to,
  };
}

function rowIdentity(row: EndpointRollupColdRow): string {
  return JSON.stringify([
    row.bucket_start,
    row.method,
    row.route,
    row.runtime,
    row.release,
    row.histogram_bounds_ms,
  ]);
}

function rowSeriesIdentity(row: EndpointRollupColdRow): string {
  return JSON.stringify([row.method, row.route, row.runtime, row.release, row.histogram_bounds_ms]);
}

function validateRowScopeAndBucket(
  row: EndpointRollupColdRow,
  range: EndpointColdArchiveRange,
): void {
  const keys = Object.keys(row).sort();
  if (
    keys.length !== ROW_KEYS.length ||
    keys.some((key, index) => key !== ROW_KEYS[index]) ||
    row.app_id !== range.app_id ||
    row.environment_id !== range.environment_id ||
    row.resolution_ms !== range.resolution_ms ||
    !Number.isSafeInteger(row.bucket_start) ||
    row.bucket_start < range.bucket_from ||
    row.bucket_start >= range.bucket_to ||
    row.bucket_start % row.resolution_ms !== 0
  )
    throw new Error('Invalid endpoint cold archive row');
}

function validateRowDimensions(row: EndpointRollupColdRow): void {
  if (
    typeof row.method !== 'string' ||
    !row.method.length ||
    row.method.length > MAX_METHOD_LENGTH ||
    typeof row.route !== 'string' ||
    !row.route.length ||
    row.route.length > MAX_ROUTE_LENGTH ||
    !RUNTIMES.includes(row.runtime) ||
    typeof row.release !== 'string' ||
    row.release.length > MAX_RELEASE_LENGTH ||
    typeof row.histogram_bounds_ms !== 'string'
  )
    throw new Error('Invalid endpoint cold archive dimensions');
  latencyHistogramSchemaFromBounds(row.histogram_bounds_ms);
}

function validateRequestMeasures(row: EndpointRollupColdRow): void {
  if (
    !Number.isSafeInteger(row.request_count) ||
    row.request_count <= 0 ||
    !Number.isSafeInteger(row.error_count) ||
    row.error_count < 0 ||
    row.error_count > row.request_count ||
    !Number.isFinite(row.duration_sum_ms) ||
    row.duration_sum_ms < 0
  )
    throw new Error('Invalid endpoint cold archive request measures');
}

function validateResponseMeasures(row: EndpointRollupColdRow): void {
  if (
    !Number.isFinite(row.response_bytes_sum) ||
    row.response_bytes_sum < 0 ||
    !Number.isSafeInteger(row.response_bytes_measured) ||
    row.response_bytes_measured < 0 ||
    row.response_bytes_measured > row.request_count
  )
    throw new Error('Invalid endpoint cold archive measures');
}

function validateObservationMetadata(row: EndpointRollupColdRow): void {
  if (
    !Number.isSafeInteger(row.last_seen) ||
    row.last_seen < row.bucket_start ||
    row.last_seen >= row.bucket_start + row.resolution_ms ||
    (row.upstream_sampled !== 0 && row.upstream_sampled !== 1)
  )
    throw new Error('Invalid endpoint cold archive observation metadata');
}

function validateRowMeasures(row: EndpointRollupColdRow): void {
  validateRequestMeasures(row);
  validateResponseMeasures(row);
  validateObservationMetadata(row);
}

function validateRowHistogram(row: EndpointRollupColdRow): void {
  let histogramTotal = 0;
  for (let index = 0; index < LATENCY_HISTOGRAM_BUCKETS; index++) {
    const value = row[`h${index}` as keyof EndpointRollupColdRow];
    if (!Number.isSafeInteger(value) || (value as number) < 0)
      throw new Error('Invalid endpoint cold archive histogram');
    histogramTotal += value as number;
  }
  if (!Number.isSafeInteger(histogramTotal) || histogramTotal !== row.request_count)
    throw new Error('Endpoint cold archive histogram does not conserve requests');
}

function validateRow(row: EndpointRollupColdRow, range: EndpointColdArchiveRange): void {
  validateRowScopeAndBucket(row, range);
  validateRowDimensions(row);
  validateRowMeasures(row);
  validateRowHistogram(row);
}

function canonicalRows(
  range: EndpointColdArchiveRange,
  rows: readonly EndpointRollupColdRow[],
): EndpointRollupColdRow[] {
  validRange(range);
  if (!rows.length || rows.length > MAX_ENDPOINT_COLD_ARCHIVE_ROWS)
    throw new Error('Endpoint cold archive row count is outside its limit');
  const canonical = rows.map((row) => {
    validateRow(row, range);
    return Object.fromEntries(
      ROW_KEYS.map((key) => [key, row[key as keyof EndpointRollupColdRow]]),
    ) as EndpointRollupColdRow;
  });
  const seriesIdentity = rowSeriesIdentity(canonical[0]!);
  if (canonical.some((row) => rowSeriesIdentity(row) !== seriesIdentity))
    throw new Error('Endpoint cold archive snapshot spans multiple series');
  canonical.sort((left, right) => rowIdentity(left).localeCompare(rowIdentity(right)));
  for (let index = 1; index < canonical.length; index++)
    if (rowIdentity(canonical[index - 1]!) === rowIdentity(canonical[index]!))
      throw new Error('Duplicate endpoint cold archive row');
  return canonical;
}

function serializeArchive(range: EndpointColdArchiveRange, rows: EndpointRollupColdRow[]): string {
  return JSON.stringify({
    format: 'app-health-endpoint-rollups',
    schema_version: ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION,
    range: canonicalRange(range),
    rows,
  } satisfies ArchiveEnvelope);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', asArrayBuffer(bytes))));
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error('Endpoint cold archive stream exceeds its byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function gzipBounded(plain: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(plain);
  if (bytes.byteLength > MAX_ENDPOINT_COLD_ARCHIVE_UNCOMPRESSED_BYTES)
    throw new Error('Endpoint cold archive exceeds its uncompressed byte limit');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return readBounded(stream, MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES);
}

function hasInvalidManifestSizes(manifest: EndpointColdArchiveManifest): boolean {
  return (
    !Number.isSafeInteger(manifest.row_count) ||
    manifest.row_count < 1 ||
    manifest.row_count > MAX_ENDPOINT_COLD_ARCHIVE_ROWS ||
    !Number.isSafeInteger(manifest.uncompressed_bytes) ||
    manifest.uncompressed_bytes < 1 ||
    manifest.uncompressed_bytes > MAX_ENDPOINT_COLD_ARCHIVE_UNCOMPRESSED_BYTES ||
    !Number.isSafeInteger(manifest.compressed_bytes) ||
    manifest.compressed_bytes < 1 ||
    manifest.compressed_bytes > MAX_ENDPOINT_COLD_ARCHIVE_COMPRESSED_BYTES
  );
}

function hasInvalidManifestCompletion(manifest: EndpointColdArchiveManifest): boolean {
  return (
    manifest.schema_version !== ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION ||
    !Number.isSafeInteger(manifest.completed_at) ||
    manifest.completed_at < 0 ||
    (manifest.source_removed_at !== null &&
      (!Number.isSafeInteger(manifest.source_removed_at) ||
        manifest.source_removed_at < manifest.completed_at))
  );
}

function validManifestIdentity(manifest: EndpointColdArchiveManifest): boolean {
  return (
    SHA256_HEX.test(manifest.content_sha256) &&
    manifest.object_key === endpointColdArchiveObjectKey(manifest)
  );
}

function validManifest(manifest: EndpointColdArchiveManifest): void {
  validRange(manifest);
  if (
    hasInvalidManifestSizes(manifest) ||
    hasInvalidManifestCompletion(manifest) ||
    !validManifestIdentity(manifest)
  )
    throw new Error('Invalid endpoint cold archive manifest');
}

export function endpointColdArchiveObjectKey(
  value: Pick<EndpointColdArchiveManifest, keyof EndpointColdArchiveRange | 'content_sha256'>,
): string {
  return `endpoint-cold/v1/${encodeURIComponent(value.app_id)}/${encodeURIComponent(value.environment_id)}/${value.resolution_ms}/${value.bucket_from}-${value.bucket_to}/${value.content_sha256}.json.gz`;
}

function equalRange(left: EndpointColdArchiveRange, right: EndpointColdArchiveRange): boolean {
  return (
    left.app_id === right.app_id &&
    left.environment_id === right.environment_id &&
    left.resolution_ms === right.resolution_ms &&
    left.bucket_from === right.bucket_from &&
    left.bucket_to === right.bucket_to
  );
}

function rangeFromManifest(manifest: EndpointColdArchiveManifest): EndpointColdArchiveRange {
  return {
    app_id: manifest.app_id,
    environment_id: manifest.environment_id,
    resolution_ms: manifest.resolution_ms,
    bucket_from: manifest.bucket_from,
    bucket_to: manifest.bucket_to,
  };
}

async function readVerifiedObject(
  bucket: EndpointColdArchiveReader,
  manifest: EndpointColdArchiveManifest,
): Promise<EndpointRollupColdRow[]> {
  validManifest(manifest);
  const object = await bucket.get(manifest.object_key);
  if (!object || !object.body || object.size !== manifest.compressed_bytes)
    throw new Error('Endpoint cold archive object is missing or has a size mismatch');
  const compressed = await readBounded(object.body, manifest.compressed_bytes);
  if (
    compressed.byteLength !== manifest.compressed_bytes ||
    (await sha256(compressed)) !== manifest.content_sha256
  )
    throw new Error('Endpoint cold archive checksum mismatch');
  let plainBytes: Uint8Array;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
    plainBytes = await readBounded(stream, manifest.uncompressed_bytes);
  } catch {
    throw new Error('Endpoint cold archive gzip is invalid or exceeds its byte limit');
  }
  if (plainBytes.byteLength !== manifest.uncompressed_bytes)
    throw new Error('Endpoint cold archive uncompressed size mismatch');
  let envelope: ArchiveEnvelope;
  const plain = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plainBytes);
  try {
    envelope = JSON.parse(plain) as ArchiveEnvelope;
  } catch {
    throw new Error('Endpoint cold archive JSON is invalid');
  }
  if (
    envelope.format !== 'app-health-endpoint-rollups' ||
    envelope.schema_version !== ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION ||
    !equalRange(envelope.range, manifest) ||
    !Array.isArray(envelope.rows) ||
    envelope.rows.length !== manifest.row_count
  )
    throw new Error('Endpoint cold archive contents do not match their manifest');
  const rows = canonicalRows(manifest, envelope.rows);
  if (serializeArchive(rangeFromManifest(manifest), rows) !== plain)
    throw new Error('Endpoint cold archive JSON is not canonical');
  return rows;
}

async function putAndVerifyObject(
  bucket: EndpointColdArchiveBucket,
  manifest: EndpointColdArchiveManifest,
  compressed: Uint8Array,
  canonicalPlain: string,
): Promise<void> {
  const digestBytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', asArrayBuffer(compressed)),
  );
  let putError: unknown;
  try {
    await bucket.put(manifest.object_key, asArrayBuffer(compressed), {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: digestBytes.buffer as ArrayBuffer,
      httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
    });
  } catch (error) {
    putError = error;
  }
  try {
    const verifiedRows = await readVerifiedObject(bucket, manifest);
    if (serializeArchive(rangeFromManifest(manifest), verifiedRows) !== canonicalPlain)
      throw new Error('Endpoint cold archive readback differs from its snapshot');
  } catch {
    if (putError) throw new Error('Endpoint cold archive PUT and readback both failed');
    throw new Error('Endpoint cold archive readback failed');
  }
}

function matchesStoredManifest(
  stored: EndpointColdArchiveManifest,
  expected: EndpointColdArchiveManifest,
): boolean {
  return (
    equalRange(stored, expected) &&
    stored.object_key === expected.object_key &&
    stored.content_sha256 === expected.content_sha256 &&
    stored.row_count === expected.row_count &&
    stored.uncompressed_bytes === expected.uncompressed_bytes &&
    stored.compressed_bytes === expected.compressed_bytes &&
    stored.schema_version === expected.schema_version
  );
}

async function recordVerifiedManifest(
  db: D1DatabaseLike,
  manifest: EndpointColdArchiveManifest,
): Promise<EndpointColdArchiveManifest> {
  const insert = db
    .prepare(
      `INSERT INTO endpoint_cold_archives
        (object_key, app_id, environment_id, resolution_ms, bucket_from, bucket_to,
         content_sha256, row_count, uncompressed_bytes, compressed_bytes, schema_version,
         completed_at, source_removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (object_key) DO NOTHING`,
    )
    .bind(
      manifest.object_key,
      manifest.app_id,
      manifest.environment_id,
      manifest.resolution_ms,
      manifest.bucket_from,
      manifest.bucket_to,
      manifest.content_sha256,
      manifest.row_count,
      manifest.uncompressed_bytes,
      manifest.compressed_bytes,
      manifest.schema_version,
      manifest.completed_at,
    );
  const select = db
    .prepare(
      `SELECT object_key, app_id, environment_id, resolution_ms, bucket_from, bucket_to,
              content_sha256, row_count, uncompressed_bytes, compressed_bytes, schema_version,
              completed_at, source_removed_at
       FROM endpoint_cold_archives WHERE object_key = ?`,
    )
    .bind(manifest.object_key);
  const results = await db.batch([insert, select]);
  const stored = results[1]?.results?.[0] as EndpointColdArchiveManifest | undefined;
  if (
    results.length !== 2 ||
    results.some((result) => !result.success) ||
    !stored ||
    !matchesStoredManifest(stored, manifest)
  )
    throw new Error('Endpoint cold archive manifest was not durably recorded');
  validManifest(stored);
  return stored;
}

/** Write an immutable shadow snapshot and record its manifest only after a bounded readback verifies. */
export async function archiveEndpointRollupSnapshot(
  bucket: EndpointColdArchiveBucket,
  db: D1DatabaseLike,
  input: {
    range: EndpointColdArchiveRange;
    rows: readonly EndpointRollupColdRow[];
    now: number;
  },
): Promise<EndpointColdArchiveManifest> {
  if (!Number.isSafeInteger(input.now) || input.now < 0)
    throw new Error('Invalid endpoint cold archive completion time');
  const rows = canonicalRows(input.range, input.rows);
  const plain = serializeArchive(input.range, rows);
  const plainBytes = new TextEncoder().encode(plain);
  if (plainBytes.byteLength > MAX_ENDPOINT_COLD_ARCHIVE_UNCOMPRESSED_BYTES)
    throw new Error('Endpoint cold archive exceeds its uncompressed byte limit');
  const compressed = await gzipBounded(plain);
  const checksum = await sha256(compressed);
  const object_key = endpointColdArchiveObjectKey({ ...input.range, content_sha256: checksum });
  const manifest: EndpointColdArchiveManifest = {
    ...canonicalRange(input.range),
    object_key,
    content_sha256: checksum,
    row_count: rows.length,
    uncompressed_bytes: plainBytes.byteLength,
    compressed_bytes: compressed.byteLength,
    schema_version: ENDPOINT_COLD_ARCHIVE_SCHEMA_VERSION,
    completed_at: input.now,
    source_removed_at: null,
  };
  await putAndVerifyObject(bucket, manifest, compressed, plain);
  return recordVerifiedManifest(db, {
    ...manifest,
    completed_at: Math.max(input.now, Date.now()),
  });
}

/** Verify an archive object before use; callers must select only retired manifests for history. */
export async function readEndpointColdArchiveRows(
  bucket: EndpointColdArchiveReader,
  manifest: EndpointColdArchiveManifest,
): Promise<EndpointRollupColdRow[]> {
  return readVerifiedObject(bucket, manifest);
}
