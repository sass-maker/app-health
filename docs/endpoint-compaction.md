# Verified endpoint history compaction

Tracking and production approval: [#130](https://github.com/sass-maker/app-health/issues/130).

## Source behavior

Recent reads stay on indexed D1. Minute aggregates remain hot for at least
35 days, hourly aggregates for at least 400 days, and daily aggregates remain
in D1. Compaction preserves the complete higher-resolution aggregate history
in immutable, checksummed gzip objects. It never stores raw requests.

Each partition contains one complete series in one closed UTC day. A scheduled
invocation processes at most 32 partitions within a shared 10-second budget,
stopping when idle or when a changed snapshot needs a later retry.
It checks the hourly/daily successor counters, histograms, bytes, sampling and
last-seen values, writes and reads back the archive, and records a shadow
manifest. Only a transaction that still matches every source field and the
complete partition size can mark the manifest retired and remove its rows.
Concurrent attempts, a changed snapshot and failed verification preserve hot
data. Readers select hot data and retired manifests in the same D1 transaction
before loading immutable objects, so retirement cannot double counts.

Limits per partition: 1,440 rows; 8 MiB uncompressed; 4 MiB gzip; 1.9 MB
retirement SQL payload; 10 seconds by default. A late upload completion can
record a verified shadow, but cannot start retirement after the time budget.
An already issued D1 transaction may complete after the caller times out;
retry uses the durable manifest and source rows to determine progress.

Historical reads are bounded to 128 objects, 20,000 selected rows, 16 MiB
total uncompressed bytes, four concurrent object reads, and a 10-second cold
read budget. Missing/corrupt objects and exceeded limits return unavailable,
never zero. Large historical fleet-wide reports can exceed these bounds; this
is an explicit coverage limit, not a claim of unlimited archive querying.

## Evidence collected September 30, 2026

A read-only production query found 20,882 minute, 4,002 hourly and 1,174 daily
rollup rows. None were older than 35 days, so no source rows are currently
eligible for the proposed retention policy. The database size reported by D1
was 99,819,520 bytes; this includes other tables and is not endpoint-only size.

A synthetic 1,440-row minute partition used 797,761 bytes of row JSON and
797,974 bytes in the canonical archive envelope; gzip used 16,820 bytes.
This fixture establishes compression behavior, not production storage savings.
SQLite failure/retry/race tests and real workerd D1/R2 tests verify historical
India-day edge reads before and after minute and hourly retirement.

## Production release gate

The implementation is inactive by default. These steps require the separately
reviewed production setup; source approval alone does not activate retirement.

1. Qualify the exact merged source and CI, and take a private D1 recovery backup.
2. Review additive migration `0027_endpoint_cold_archives.sql` and apply it
   with the repository's production migration script.
3. Provision a dedicated App Health R2 bucket (proposed name
   `app-health-endpoint-history`) with no expiration lifecycle, and attribute it
   to canonical project `app-health` in the Fleet catalog. Regenerate consumers.
   The existing browser-history bucket expires after 30 days and is unsuitable.
4. Bind it as `ENDPOINT_HISTORY`, keeping `ENDPOINT_COMPACTION_ENABLED` absent.
   Release the reader first; qualify a synthetic isolated archive and recovery
   drill without changing real report counts.
5. Verify object recovery, retention policy, deployed source, current read parity
   and historical report bounds. Activate scheduled retirement only after this
   evidence and explicit activation approval.

## Operational recovery

The durable checkpoint is `endpoint_cold_archives.source_removed_at`: NULL
means the original rows remain authoritative; non-NULL means the verified
object supplies that resolution. Scheduled completion logs report state and
row count; failures emit `endpoint_compaction_failed` without route data.
Inspect aggregate shadow/retired manifest counts to distinguish incomplete
work from successful retirement.

To stop new work, remove the activation flag while retaining the reader and
the history binding. Do not roll back to a version without cold-history reads
after any retirement. Preserve the bucket, manifests and daily aggregates.
If an object is unavailable, restore the exact checksummed object from recovery
storage and verify it before retrying the read. Never substitute an empty
object or delete a manifest to make a report appear healthy.
