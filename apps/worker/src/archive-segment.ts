import type { ArchiveSegmentManifest } from '@app-health/contracts';
import type { CollectedBrowserBatch } from './browser-analytics.js';

type ArchiveBucket = Pick<R2Bucket, 'put' | 'get'>;

function manifestFor(
  key: string,
  body: string,
  compressedBytes: number,
  digest: Uint8Array,
): ArchiveSegmentManifest {
  const batches = body
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row) as CollectedBrowserBatch);
  const workspace = batches[0]?.workspace;
  if (
    !workspace ||
    workspace.length > 100 ||
    batches.some((batch) => batch.workspace !== workspace)
  )
    throw new Error('Archive manifest workspace mismatch');
  let minimum = Infinity;
  let maximum = 0;
  let events = 0;
  for (const batch of batches) {
    for (const event of batch.events) {
      if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0)
        throw new Error('Archive manifest invalid event timestamp');
      minimum = Math.min(minimum, event.timestamp);
      maximum = Math.max(maximum, event.timestamp);
      events++;
    }
  }
  if (!events) throw new Error('Archive manifest requires events');
  return {
    schema_version: 1,
    object_key: key,
    workspace_id: workspace,
    format: 'jsonl-gzip',
    content_sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    row_count: batches.length,
    event_count: events,
    min_event_at: minimum,
    max_event_at: maximum,
    uncompressed_bytes: new TextEncoder().encode(body).byteLength,
    compressed_bytes: compressedBytes,
    created_at: Date.now(),
    state: 'active',
  };
}

async function verifyExisting(
  bucket: ArchiveBucket,
  key: string,
  bytes: number,
  expected: Uint8Array,
): Promise<void> {
  const existing = await bucket.get(key);
  if (!existing || existing.size !== bytes) {
    await existing?.body.cancel();
    throw new Error('Archive object missing or size mismatch; staging retained');
  }
  const actual = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await existing.arrayBuffer()),
  );
  if (!actual.every((byte, index) => byte === expected[index]))
    throw new Error('Archive object checksum mismatch; staging retained');
}

/** Manifest metadata and the immutable fact bytes commit together in one R2 PUT. */
export async function persistArchiveSegment(
  bucket: ArchiveBucket,
  key: string,
  body: string,
  compressed: ArrayBuffer,
): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', compressed);
  const expected = new Uint8Array(digest);
  const manifest = manifestFor(key, body, compressed.byteLength, expected);
  const created = await bucket.put(key, compressed, {
    onlyIf: { etagDoesNotMatch: '*' },
    sha256: digest,
    httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
    customMetadata: { manifest: JSON.stringify(manifest) },
  });
  // Older immutable segments can lack manifests. Verify the bytes without
  // rewriting their metadata; a separate backfill can index them later.
  if (!created) await verifyExisting(bucket, key, compressed.byteLength, expected);
}
