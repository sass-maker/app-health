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

Browser archive objects are durable facts, not a cache. The Worker performs no
age-based R2 deletion. Physical source objects may eventually be superseded by
larger Parquet/Iceberg files, but only after a versioned proof verifies distinct
source and replacement keys plus equal row and event counts. The production R2
30-day lifecycle predates this contract and must be removed as a separate,
reviewed provider change before any object reaches it. Application logs remain
queryable in their 30-day hot retention with level/source/event filters and
bounded scheduled cleanup; durable log rollups are tracked separately.

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

Queue retries and immutable archive staging have real local workerd tests. The
code no longer deletes browser archives by age, while production still has the
older 30-day R2 lifecycle until an explicitly approved provider change removes
it. Analytics Engine is a best-effort projection and historical reports can lag
ingestion; archive replay and long-range rollup queries are tracked in
[issue #62](https://github.com/sass-maker/app-health/issues/62).

## Native integration boundary

The Foundation Swift package uses separately scoped native public keys, named
native events, explicit logs, and opt-in foreground sessions. It never fabricates
browser page views or puts client-observed network timing into server endpoint
health. Twelve Swift tests and a real native executable-to-collector canary passed.
See [native integration](native-integration.md) for local-package installation;
remote Swift package publication and persistent offline delivery remain separate.
App Store Connect is outside this product.
