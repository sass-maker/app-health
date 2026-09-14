# App Health backend dogfooding

Tracking: [#63](https://github.com/sass-maker/app-health/issues/63).

App Health uses its own `@saas-maker/app-health` SDK and `/v1/ingest` contract
for endpoint summaries. Known dashboard API routes expose request volume,
errors, and latency in the existing Backend view. Timing includes authentication
and handler work until a Response is returned; it excludes response-body
streaming, browser/network latency and background tasks.

Only normalized route, method, status, duration, timestamp and SDK protocol
metadata are sent. Project IDs, environment IDs in paths, query values,
headers, cookies and bodies are not copied. Collector routes, WebSocket/live
connections, assets, unknown routes and preflight requests are excluded.

## Activation

After explicit production approval:

1. Create a dedicated **environment-scoped private ingest key** for the existing
   App Health project's production environment. Do not use the public browser
   key or a product key requiring an environment selector.
2. Set that key as the Worker secret `APP_HEALTH_SELF_BACKEND_KEY`. Never put it
   in tracked config, browser config or a frontend environment variable.
3. Keep the existing `APP_HEALTH_DASHBOARD_HOST`, `APP_HEALTH_INGEST_HOST` and
   HTTPS `APP_HEALTH_INGEST_ORIGIN` bindings. The destination host is validated.
4. Release, visit the signed-in dashboard, and confirm `/v1/apps`, `/v1/endpoints`
   and `/v1/analytics/report` receipts in App Health's production Backend view.
   Confirm installation/last-seen and actual persisted measurements, not just
   HTTP success. Validate same-Worker custom-domain delivery on the live deploy.

No schema migration or new infrastructure is needed. Without the optional
secret, monitoring stays disabled. Revoking its dedicated key stops acceptance;
removing the secret also stops outbound delivery. This cannot replace external
monitoring of complete collector outages, since delivery uses App Health itself.

## Delivery and cost

Each measured request has one timer-free SDK client and one summary. Delivery
uses `waitUntil` and never delays the response for collector I/O. There is one
outbound ingestion batch per measured request, at most one retry, and a 1.5s
per-attempt timeout. Stable batch/event IDs make SDK retries deduplicable.
Failures produce only a fixed diagnostic event, without exception details.

This deliberately avoids unsafe cross-request queues inside Worker isolates.
It adds one collector request per dashboard API request (plus a bounded retry
on transient failure); ingestion requests never generate further summaries.
Retention and aggregate storage use the existing endpoint pipeline unchanged.

## Verification

`apps/worker/test/self-backend.test.ts` covers SDK-to-collector delivery, latency,
fail-open behavior, response identity, privacy, concurrency and exclusions.
`pnpm --filter @app-health/worker run verify:accounts-runtime` exercises the
actual workerd SDK transport and collector with a synthetic scoped key, and
checks the persisted D1 route and installation receipt. Its outbound network is
local-only; it does not provision or contact production.

The Worker enables `global_fetch_strictly_public` so its own ingest hostname
re-enters Cloudflare's public routing instead of bypassing the Worker. This is
required for self-dogfooding; the ingestion exclusion prevents recursion. See
[Cloudflare compatibility behavior](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public).
