# Drop-in log client

These are legacy examples, retained for existing integrations. They send one
request per log and do not provide the maintained SDK's bounded batching, retry
and shutdown guarantees. Use `appHealth.log()` or `createWebLogger` for new
integrations; this readiness pass does not modify consumer projects.

`ping.ts` is a zero-dependency sender for App Health application logs. Copy it
into an app, set `APP_HEALTH_INGEST_KEY` (and `APP_HEALTH_ENVIRONMENT`), and
call `ping('signup', { title, props })`. One POST per call to `/v1/logs`; no
batching, no timers, safe on Cloudflare Workers and Node alike.

`ping-web.ts` is the browser counterpart for static sites: it takes a public
log key (`ahk_pub_…`, created in the dashboard's Logs tab and pinned to your
origin) and posts one `text/plain` batch per call, switching to `sendBeacon`
when the page is hiding.

Use the SDK (`appHealth.log()` on servers, `createWebLogger` from
`@saas-maker/app-health/web` in bundled frontends) when the app already
installs the package. Wiring guide and decisions: [docs/logs.md](../../docs/logs.md).

## Plain-JS site snippet

`app-health-log.template.js` is what the fleet sites actually ship: a
self-contained script (no bundler, no TypeScript) placed at
`public/app-health-log.js` and referenced once from the shared head as
`<script src="/app-health-log.js" defer></script>`. Replace `__PUBLIC_KEY__`
with the site's public key. It auto-logs `form.submitted`, `[data-log]` clicks,
and `client.error`, and exposes `window.appHealthLog(event, options)`.
Self-hosting keeps it inside `script-src 'self'`; add
`https://ingest.sassmaker.com` to `connect-src` where a CSP exists.
