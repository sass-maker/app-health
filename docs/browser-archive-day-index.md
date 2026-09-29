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
