# App Health efficiency and readiness

This note describes the bounded design for browser analytics and the checks
needed before production activation. It is an efficiency target, not a dollar
cap or an event cap. Low traffic should fit within the included allowances in
the account's existing Workers plan, but this account is shared and no bill can
be guaranteed from code-level limits.

## Data path

The browser SDK and tracker use bounded batches. The standalone tracker keeps at
most 100 queued events, sends at most 25 per request, waits 1.5 seconds before
flushing, and retries a transient batch at most three times. A visible page sends
a heartbeat every 30 seconds. Presence does not use the Queue or archive, and a
workspace with no dashboard watcher avoids the live stream's frequent cleanup
alarms. Reports use a 60-second workspace-scoped cache. Hidden dashboards stop analytics, project, setup, endpoint and log polling; analytics requests are aborted and live sockets close until the dashboard becomes visible again.

The Queue consumer hashes each batch identity into one of 16 stable shards per
workspace. The shard writes SQLite stage rows before acknowledging Queue
messages, so an R2 outage retries from the Durable Object alarm without losing the accepted stage. Queue delivery retries only if staging fails. It
seals pending JSONL into gzip segments capped at 1 MiB, with both size and time
alarms. R2 objects are immutable and retried; the batch dedupe ledger retains
identities for 31 days. SQLite bounds pending batches, pending bytes, stage
batch size, and ledger rows so backlog growth fails closed and can drain.

Application archive expiry is suspended: the existing gzip archive has no
verified compacted successor, so age alone cannot authorize deleting it.
**Release prerequisite:** remove the independent production R2 30-day lifecycle
rule and verify it with the provider. Changing application code does not disable
that rule. Raw application logs retain their separate 30-day hot retention.

### Endpoint correctness foundation (prepared, not released)

Migration `0014_endpoint_rollups.sql` must be applied before deploying this code.
Endpoint ingestion uses the existing D1 binding to commit retry receipts and
minute/hour/day aggregates in one transaction. SDK retries use scoped batch IDs;
OTLP retries use scoped event IDs, including overlapping exports. Event-time
buckets accept the existing five-minute skew window. No raw successful request
rows are stored. Counts, errors, duration sums, histogram bounds and bin counts,
release/runtime, and upstream sampling provenance are preserved. Bounds are part
of the series key so future histogram changes cannot silently merge incompatible
states. Upstream-sampled OTLP represents observed samples, not all traffic.

A batch uses five SQL statements in one transaction. All three resolutions are
updated only for active groups; there are no empty bucket writes or periodic
full-history scans. This adds up to three aggregate row writes per affected
series/bucket plus receipts, rather than one stored row per successful request.
One SDK batch receipt or one receipt per distinct OTLP event is retained for
24 hours. Admission rejects timestamps older than five minutes, so expired
receipts cannot re-admit a valid unchanged retry. Aggregate history is preserved;
automated high-resolution compaction/expiry remains pending #62. D1 size and row
write growth must be measured before scaling this interim adapter.

The canonical transaction precedes Analytics Engine projection. A projection
failure cannot remove durable counts, and a retry after a lost acknowledgement
cannot increment them again. Auxiliary installation/inventory records are written
before the transaction and may show observed traffic from a failed ingest.
Backend reports now combine durable D1 measurements with legacy-only AE data.
New AE projections carry `blob7 = durable-v1` and are excluded from legacy reads,
so the same measurement is never added from both stores. Both queries run in
parallel; either failure remains an error instead of silently removing traffic.
Reports use completed UTC minute windows (up to 60 seconds freshness delay) and
return their exclusive `window_end` separately from `refreshed_at`. Long windows
read disjoint daily/hourly interiors and minute edges, using at most five indexed
ranges rather than scanning all minute rows or adding overlapping tiers. Histogram
schemas and totals are checked before returning durable data. Old AE data can
still be sampled or incomplete; there is no historical backfill. Replay and
reconciliation remain open in #62. New raw log-count rollups and
web/session historical rollups are also outside this implementation slice.

Analytics Engine (AE) is a best-effort sampled projection used for hot reports,
not a billing ledger. The stage-to-AE crash gap can undercount a report even
when the R2 archive is present. There are no replay, export, or reconciliation
tools yet, so production activation must keep that limitation visible.

Queue batching reduces request overhead and lets the consumer bound RPC work; it
does not reduce Queue's per-message operation accounting. Cloudflare counts
operations per 64 KB of message data, including retry reads. Bounded payloads and
the application caps are workload controls, not a monetary guarantee. See the
[Queues pricing documentation](https://developers.cloudflare.com/queues/platform/pricing/),
[R2 pricing documentation](https://developers.cloudflare.com/r2/pricing/), and
[Analytics Engine pricing documentation](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).
The AE page currently says usage is not billed and publishes advance pricing;
that is not a promise about future rates or this shared account's total bill.

## Measured local proof

`node examples/cloudflare-sample/verify.mjs` currently reports these local
measurements (Miniflare plus a real browser, not production billing or capacity):

- Production and staging each received 1 page view, 1 named event, 3 endpoint
  rows, 2 logs, and 1 failure; each browser drive made 8 browser network
  requests.
- The collector proxy observed 12 telemetry requests and 4,732 payload bytes:
  6 `/v1/ingest`, 4 `/v1/logs`, and 2 `/v1/browser` requests.
- The tracker measured 5,972 raw bytes and 2,039 gzip bytes. The sample's
  bundled browser surface measured 4,788 raw bytes and 2,178 gzip bytes.
- The proof kept private keys out of browser assets, preserved environment
  isolation, and product responses survived collector failure.

These are repeatable local integration measurements, not a production capacity
or billing forecast. The unified runtime and bounded production resources are
now deployed. See [release verification](release-2026-09-12.md) for actual
Google, ingestion, analytics, and public-sharing receipts.

## Operational boundaries

Queue retries, immutable archive staging, and retention cleanup have real local
workerd tests. Production has bounded Queue retention and a 30-day R2 lifecycle;
full retention expiry and sustained-load billing have not been observed over a
month. Analytics Engine is a best-effort projection and historical reports can
lag ingestion; archive replay is not implemented. Keep these limitations visible.

## Native integration boundary

The Foundation Swift package uses separately scoped native public keys, named
native events, explicit logs, and opt-in foreground sessions. It never fabricates
browser page views or puts client-observed network timing into server endpoint
health. Twelve Swift tests and a real native executable-to-collector canary passed.
See [native integration](native-integration.md) for local-package installation;
remote Swift package publication and persistent offline delivery remain separate.
App Store Connect is outside this product.

## Cloudflare storage decision — 2026-09-14

Cloudflare identifies [Analytics Engine as its time-series/metrics database](https://developers.cloudflare.com/workers/platform/storage-options/).
It is already integrated here, but its [three-month retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
does not satisfy durable history by itself.

[Pipelines](https://developers.cloudflare.com/pipelines/platform/limits/) and
[R2 SQL](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/)
remain open beta. Pipelines writes analytical files/tables; R2 SQL reads Parquet
in Iceberg tables, supports analytical aggregation, and is read-only. Our gzip
JSONL archives cannot simply be queried through that interface. This remains a
candidate for historical cross-filtering after a verified conversion/backfill,
not a replacement for transactional ingest receipts.

[R2 SQL pricing](https://developers.cloudflare.com/r2-sql/platform/pricing/)
includes 10 GB scanned/month, then $0.0025/GB, with a minimum 10 MB per query,
plus R2 and catalog charges. A dashboard polling every 15 seconds continuously
would issue 172,800 queries in 30 days: a minimum 1,728 GB accounted scans before
caching, approximately $4.30 query charges after the allowance, excluding storage,
operations and other account usage. This is an illustrative arithmetic scenario,
not a benchmark or forecast; actual UI polling pauses when hidden. Frequent hot
queries should use indexed summaries and caching, while history queries can use
partitioned files. We are keeping D1 aggregates plus existing R2 archives now;
no beta lake dependency is introduced into the live dashboard path.
