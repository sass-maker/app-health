# App Health for Node.js

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
appHealth.log('signup', { title: user.email, props: { plan: 'free' } });
appHealth.log('waitlist.join', { title: email, icon: '📝', props: { source } });
appHealth.log('payment.failed', { level: 'error', description: err.message });
```

`log()` is non-blocking and fails open like `record()`. Levels are `debug`,
`info` (default), `warn`, and `error`. Event names are lowercase
(`signup`, `waitlist.join`, `payment:failed`); props hold up to 40 strings,
numbers, booleans, or nulls. Logs travel to `/v1/logs` on the same ingest host
and appear in the dashboard's Logs tab within seconds, filterable by level and
event. When the owner has configured a Slack webhook, logs at or above the
configured level are posted there too.

### From the browser

Pages use a **public** log key (`ahk_pub_…`) created in the dashboard's Logs
tab. It is not a secret: the server pins it to one environment and an origin
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
`navigator.sendBeacon` when the tab is hidden or closing. Under 2 KB, no
dependencies. Static sites can copy `examples/dropin-log-client/ping-web.ts`
instead of installing the package.

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
