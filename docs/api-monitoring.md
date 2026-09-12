# API monitoring

Connect an environment's private ingestion key using the appropriate middleware
in the [JavaScript SDK](../packages/node/README.md), or the existing Go adapter.
The **Endpoint health** page shows routes the service actually handled. This is
passive request measurement: it does not probe uptime or discover unused routes.

## Measurement contract

- Events contain method, normalized route template, response status, duration,
  timestamp, and optional release. Official adapters do not capture request
  bodies, headers, query values, cookies, or concrete route parameters.
- Error rate means HTTP **5xx / requests**. Recent failure details include both
  4xx and 5xx, retained for 24 hours. These are distinct measurements.
- p50 and p95 come from a merged fixed histogram, not averaged percentiles.
  Values represent histogram bounds rather than exact individual durations.
- The supported report windows are 15 minutes, one hour, and 24 hours. Local
  storage uses minute buckets; production Analytics Engine windows use collector
  receipt time. Delayed batches can therefore cross a window boundary. Last seen
  reports the event timestamp. Events beyond five minutes of clock skew are rejected.
- Fewer than 20 requests yields insufficient data. With enough requests, at least
  1% errors or 1 second p95 is degraded; at least 5% errors or 2 seconds p95 is
  unhealthy. These are fixed explanatory defaults, not configured alert rules.
- Sampled storage and sampled upstream trace contributions are labelled. An
  inventory record without report measurements remains visible with unavailable
  metrics; it is never presented as zero traffic or a healthy endpoint.

## Delivery and limits

Ingestion authenticates the key and environment, validates a bounded payload,
and deduplicates retried batches. Official SDKs buffer and retry within fixed
bounds; a failed collector must not fail the instrumented application.

The production adapter permits at most 250 distinct measurement groups per
request, matching its Analytics Engine write limit. Groups combine environment,
method, route, latency bucket, and release. A larger expansion returns HTTP 413
before dedupe, inventory, failures, or metric writes. Reduce batch size; repeated
delivery of an identical oversized batch cannot succeed. Multiple events in the
same group still compact into one point.

This is operational telemetry, not an exactly-once billing ledger. Analytics
Engine writes and D1 metadata do not share a transaction; partial provider
failures can lose or duplicate aggregate contributions. Bounded SDK buffers can
drop events during sustained outages. Counts and histogram estimates must be
interpreted with those delivery and sampling limits.

## Read reliability and verification

Provider queries have a ten-second timeout, validate response shape and numeric
values, and use explicit requested time bounds. Malformed successful responses
fail closed. The dashboard validates both endpoint and installation responses,
prevents overlapping polls, aborts obsolete requests, and clears old values when
the project, environment, or window changes. Sorting runs locally.

`scripts/verify-local-sdk.mjs` runs a real Express service and collector, checks
normal and failing requests, normalized paths, all three windows, retained
failures, key revocation, and retained reports after revocation. The Cloudflare
checkout sample independently verifies Hono measurement and environment isolation.
Focused tests cover provider validation, histogram merging, batch replay,
preflight capacity, concurrent environment creation, and dashboard request races.

These checks prove local behavior. The current account/environment changes still
need explicitly authorized production activation and a deployed canary before
they can be claimed live. See [production canary](production-canary.md).
