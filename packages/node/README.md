# App Health for Node.js

The current readiness fixes are local and unreleased. The release URL below
still refers to the existing v0.3.0 artifact. Verify a local build with
`pnpm --filter @saas-maker/app-health pack:verify` before integration testing.

Privacy-first endpoint health telemetry for Node.js 20+, Express, Hono Workers,
and Cloudflare Pages Functions. The SDK
records only the HTTP method, framework route template, response status,
duration, timestamp, and optional release. It does not read headers, query
values, route parameters, request or response bodies, cookies, or identities.
Unmatched concrete paths are dropped, and unsafe free-form release strings are
omitted.

## Express

The SDK is distributed through the public GitHub release below. The npm
registry package is not currently available.

```bash
npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz
```

```ts
import { createAppHealthClient } from '@saas-maker/app-health';
import { expressMiddleware } from '@saas-maker/app-health/express';

const appHealth = createAppHealthClient({
  key: process.env.APP_HEALTH_INGEST_KEY!,
  environment: process.env.APP_ENV ?? 'production',
  endpoint: 'https://ingest.sassmaker.com/v1/ingest',
  release: process.env.APP_VERSION,
});

app.use(expressMiddleware({ client: appHealth }));
```

The middleware is asynchronous and fail-open. On graceful shutdown, flush the
bounded queue:

```ts
await appHealth.close();
```

Use `appHealth.diagnostics()` to inspect queued, sent, failed, retried, and
dropped event counts locally.

## Application logs

Endpoint telemetry is derived from traffic and never carries identity. Logs are
the opposite: explicit events your code chooses to send, with whatever detail
you put in them. Use them for the moments you want to hear about.

```ts
appHealth.log('signup', { title: 'Signup completed', props: { plan: 'free' } });
appHealth.log('waitlist.join', { title: 'Waitlist joined', icon: '📝', props: { source } });
appHealth.log('payment.failed', { level: 'error', description: err.message });
```

`log()` is non-blocking and fails open like `record()`. Levels are `debug`,
`info` (default), `warn`, and `error`. Event names are lowercase
(`signup`, `waitlist.join`, `payment:failed`); props hold up to 40 strings,
numbers, booleans, or nulls. Logs travel to `/v1/logs` on the same ingest host
and appear in the dashboard's Logs tab within seconds, filterable by level and
event. The deployment-wide Slack webhook applies only to legacy projects;
account-owned workspace destinations are not implemented yet.

### From the browser

Pages use a **public** log key (`ahk_pub_…`) created in Project settings. It is not a secret: the server pins it to one environment and an origin
allowlist, rate limits it, and stores what it receives as `source: browser`.
Keep money and account facts on the server; use the browser for what the
server never sees.

```ts
import { createWebLogger } from '@saas-maker/app-health/web';

const logs = createWebLogger({ publicKey: 'ahk_pub_…', environment: 'production' });
logs.log('pricing.viewed', { props: { plan: 'pro' } });
logs.log('checkout.abandoned', { level: 'warn', title: cartId });
```

Batches go out as `text/plain` (no CORS preflight) with `keepalive`, and via
`navigator.sendBeacon` when the tab is hidden or closing. This optional entrypoint
has no runtime dependencies and does not import the server client. It retains
at most 200 logs by default, batches at most 50 logs and 60 KiB per request,
and attempts transient failures at most three times with two-second request
timeouts and backoff. Retries preserve batch identity. Beacons are browser
handoffs, not delivery acknowledgements; acknowledged retries update `sent`.
`diagnostics()` distinguishes sent, dropped, retried and pending beacon events.
Call `await logs.close()` to detach listeners and finish retained work.

The standalone analytics script is separate and remains within a 2 KB gzip
budget. The old drop-in log examples are legacy integrations without these
batching and lifecycle guarantees; use the maintained SDK for new integrations.

## Hono on Cloudflare Workers

Until npm publisher authentication is restored, install the same verified
package from its immutable public release:

```bash
npm install https://github.com/sass-maker/app-health/releases/download/node-v0.3.0/saas-maker-app-health-0.3.0.tgz
```

```ts
import { createAppHealthClient } from '@saas-maker/app-health';
import { honoMiddleware } from '@saas-maker/app-health/hono';

const appHealth = createAppHealthClient({
  key: env.APP_HEALTH_INGEST_KEY,
  environment: env.APP_ENV ?? 'production',
  endpoint: 'https://ingest.sassmaker.com/v1/ingest',
  runtime: 'worker',
  disableTimer: true,
});

app.use('*', honoMiddleware({ client: appHealth }));
```

The adapter uses Hono's matched route template after routing and registers
delivery with `ExecutionContext.waitUntil`.

## Cloudflare Pages Functions

Pages routing is file-based, so pass a trusted static route template:

```ts
import { withPagesFunctionHealth } from '@saas-maker/app-health/pages';

export const onRequestGet = withPagesFunctionHealth(
  { client: appHealth, route: '/anime/:malId' },
  async () => Response.json({ ok: true }),
);
```

Both Worker adapters accept a lazy `client` resolver that may return `null`.
Use that form when the ingest-key binding is optional; missing configuration
then leaves the application unchanged.

Server requests are bounded by the collector's 256 KiB body limit. Endpoint
batches contain at most 250 events to stay within provider aggregation limits;
`maxBatchSize` is an upper bound, not a guaranteed request size. `close()` waits
for an active flush. Optional instrumentation hooks cannot change application
responses or replace handler errors.

See [the runtime verification matrix](../../docs/javascript-runtimes.md) for
the exact Node, Bun, Deno, Cloudflare and browser qualification commands.

# Optional public analytics viewer

The unreleased `@saas-maker/app-health/viewer` entry reads aggregate analytics
using a revocable `ahs_` share link token. It has no ingestion capabilities or
runtime dependencies. See [public analytics integration](../../docs/public-analytics.md#optional-javascript-viewer)
for a custom widget, lifecycle handling, scope and revocation. The default iframe
remains available when you do not need a custom UI.
