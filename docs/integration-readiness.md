# Integration readiness — 2026-09-12

This records the sequential core readiness pass in
[issue #58](https://github.com/sass-maker/app-health/issues/58). App Health is the
product; Site Health remains Fleet's private portfolio system. Production
resources, account migrations, and provider preparation are complete, while the
Worker code is awaiting deployment and the real Google callback is not yet
verified.

| Stage               | Verified behavior                                                                                                                                                                              | Integration guide                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1. API measurements | Default Express/Cloudflare instrumentation; normalized routes, errors, latency, time windows, scope, retry and revoked keys; safe collector-failure behavior                                   | [API monitoring](api-monitoring.md)           |
| 2. Logs             | Explicit levels/properties, server/browser/native source labels, bounded batches, retry deduplication, scope, filters and 30-day retention                                                     | [Logs](logs.md)                               |
| 3. Analytics        | Automatic web pageviews, explicit events, live sessions, project/environment isolation, setup-to-data receipts and bounded query/ingest behavior                                               | [Browser analytics](browser-analytics.md)     |
| 4. JavaScript       | Actual Node 24, Bun, Deno, Cloudflare workerd/Hono and Chromium integrations; external ESM/CommonJS package consumers                                                                          | [JavaScript runtimes](javascript-runtimes.md) |
| 5. Swift            | Foundation Swift 6 package for iOS/macOS, separate scoped native public keys, explicit events/logs, foreground sessions, bounded queue/retries and shutdown; real executable-to-collector HTTP | [Native integration](native-integration.md)   |
| 6. Public viewer    | Existing link/iframe plus optional JavaScript viewer; cross-origin aggregate reads, cookie omission, visibility pause, timeout/backoff, revocation and stale-data clearing                     | [Public analytics](public-analytics.md)       |

Use individual optional SDK entries for the capabilities a project needs.
Backend credentials remain private. Browser public keys require an allowed
origin; native public keys carry untrusted native claims. Public viewing tokens
can only read a deliberately limited aggregate projection.

## Verification

- `pnpm run check`: repository quality gate, real Express and Cloudflare sample,
  real workerd/D1/Queue/archive canary, coverage and dashboard browser journeys.
- `pnpm run verify:js-runtimes`: real Node/Bun/Deno transport compatibility.
- `pnpm --filter @saas-maker/app-health run pack:verify`: external ESM and
  CommonJS consumers of the packed package, including the optional viewer.
- XcodeBuildMCP Swift package build/test: **12 passing tests**, including
  concurrency, queue limits, UTF-8 payload splitting and foreground sessions.
- `node scripts/verify-swift-runtime.mjs`: built native executable sends events
  and logs to the actual local collector, then proves revoked-key rejection.
- `node scripts/verify-public-viewer.mjs`: real Chromium widget on a separate
  origin reads scoped aggregates and clears after revocation.
- `.fleet/evidence/native/`: real setup/key/revocation journey screenshots in
  dark/light at 390 and 1440 pixels, with no dashboard footer or page overflow.

## Remaining activation and capability boundaries

Worker deployment, real Google OAuth callback verification, published SDK
versions, and integration into actual Fleet apps still need their own activation
and live canaries. Self account milestones are server-side, scoped to the
configured App Health app/environment, and carry no profile, project identifier,
or credential data. All credentials in local canaries are synthetic.

This is the core integration foundation, not full DataFast/PostHog parity.
Advanced funnels, revenue attribution, long-range exploration and exports remain
separate capability work. Analytics Engine writes are best-effort projections;
archives exist, but projection replay/reconciliation is not implemented. Native
delivery has no persistent offline queue. Logs do not yet have per-workspace
Slack destinations, archive export or pagination. These limits are not silently
treated as completed functionality.
