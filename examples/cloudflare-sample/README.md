# Cloudflare checkout sample

This Hono Worker shows App Health as three independent, optional capabilities in a realistic
checkout:

- `honoMiddleware` records normalized endpoint summaries for `/api/*` routes.
- `client.log()` sends an explicit server log after a checkout, with delivery registered through
  `ctx.waitUntil()`.
- The browser tracker records page views and the named `checkout.<environment>.completed` event.
- `createWebLogger()` sends the matching explicit browser log with an origin-bound public key.
- An intentional unavailable-checkout route proves that a normalized `503` appears in endpoint
  health and failure details.

The Worker reads its private environment key only from the `APP_HEALTH_PRIVATE_KEY` binding. The
HTML and browser bundle receive a separate public key. Production and staging run with independent
keys and environment bindings.

Run the local integration proof from the repository root:

```sh
node examples/cloudflare-sample/verify.mjs
```

The verifier builds the published package surface, starts the repository's real local App Health
collector, bundles this sample, and runs production and staging in Miniflare. It uses a real browser
to complete both checkouts, then queries App Health reports to prove endpoint, analytics, and log
receipt and environment isolation. It also runs the product routes with an unreachable collector to
prove telemetry failures do not change their responses, and reports measured request/payload and
gzip asset sizes. All keys and runtime configuration stay in process memory and a temporary
directory; this example intentionally includes no deployment configuration or secret.

The sample uses compatibility date `2026-07-29`, the newest date supported by the repository's
currently pinned Miniflare/workerd runtime.
