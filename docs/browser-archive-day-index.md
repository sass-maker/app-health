# Browser archive event-day index

Each browser archive Durable Object keeps a SQLite index from an Asia/Kolkata
event day to the immutable R2 segments that contain events from that day. The
index is written in the same local transaction that releases staged rows, and
only after the segment upload has succeeded or an existing object has been
verified. A segment can appear under multiple event days. Late events use their
event timestamp, regardless of the segment's upload-date key.

The same completion transaction also records a batch identity `(app_id,
environment_id, batch_id)` to its segment key. A caller can use this lookup as a
per-batch archive receipt candidate after the upload commit.

`archiveSegmentsForEventDay(day, cursor, limit)` returns at most 100 segment
references from one archive shard and a cursor for the next page. Page one
captures a monotonic `snapshot_sequence`; continuation pages carry it and exclude
later inserts even if their object keys sort before the cursor. Callers must
query all 16 workspace shards and fetch/verify segment objects separately. The
index retains references for 35 days from successful upload and prunes at most
1,000 expired rows per write or read. Complete pagination promptly because
references can age out during a long scan.

The day index is a lookup aid, not a coverage receipt. Empty results can mean
no indexed segment was found in that shard; they do not establish that the day
had no events or that all accepted batches were archived. Exhausting pages
proves only that the captured index snapshot was enumerated. It must not be
treated as current-state completeness without a Queue/DLQ barrier and a
refreshed scan after ingestion is quiescent. Batch mappings only prove that a
batch was included in an uploaded segment after R2 verification; they do not
prove that every accepted batch was delivered from Queue or staged before
upload. Neither lookup verifies current R2 availability, acquires bytes,
reconciles facts, or advances a watermark. Queue/DLQ reconciliation remains
separate work.

## Offline day auditor

`auditBrowserArchiveDay` in `apps/worker/src/browser-archive-day-audit.ts` is
an internal/offline acquisition helper. Given an owned workspace, India day,
D1 handle, archive namespace, and R2 bucket, it discovers at most 128
app/environment scopes, pages up to 10,000 D1 receipts, and visits the
event-day index on all 16 archive shards with stable snapshot cursors. It makes
up to 100 batch-index lookups, with at most 25 concurrent DO RPCs; further
receipts are explicitly marked unverified and cannot be reported as matched.
It examines at most 5,000 unique segments, 2 MiB compressed and 2 MiB
decompressed per object, 64 MiB compressed and 8 MiB decompressed in total,
and 10,000 archive facts. It validates each manifest, compressed SHA-256, gzip
contents, row/event counts, and event-time bounds, then passes verified facts
to `reconcileBrowserArchiveDay`.

The returned object contains only the day, aggregate state counts, bounded work
counts, and reason codes; it does not return receipt IDs, visitor hashes,
archived events, object keys, or provider errors. Any missing/corrupt evidence,
page or fact cap, RPC failure, or comparison cap remains incomplete. It always
reports `complete: false`: Queue and DLQ reconciliation, D1/R2 retention, and a
current-state ingestion barrier are not inputs to this offline helper. Exhausted
snapshot pages do not close those proof gates and never advance visitor-day
coverage metadata.

Stream readers cancel their source as soon as a compressed or decompressed
limit is crossed. A fallback lookup cap, any unvisited snapshot page, or
unfetched object adds an incomplete reason. Receipts with a skipped batch-index
lookup are excluded from matched and missing counts and appear only in the
aggregate `unverified_receipts` count.

The helper does not call external provider APIs or read Queue/DLQ state. Its
result is useful for bounded evidence collection and comparison only. It is
not a production completeness certificate, a retention claim, a coverage
watermark, or a Daily briefing fallback.
