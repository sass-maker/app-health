# Application logs

Owner-authored events with levels, stored per app and environment, shown in the
dashboard's Logs tab and optionally posted to Slack. This page is the canonical
home for how to wire an app and why the feature is shaped the way it is; the
README carries the one-paragraph summary.

## Wire an app

1. Create the app in the dashboard (or reuse one) and copy its ingest key.
2. Send logs one of two ways:
   - **Node SDK**: `appHealth.log('signup', { title: 'New signup', props: { plan } })`
     on the existing client. Logs share the queue and flush cycle with endpoint
     events and travel to `/v1/logs`.
   - **Any runtime, zero dependencies**: copy `examples/dropin-log-client/ping.ts`
     into the app and call `ping('signup', { title, props })`. It posts one
     batch per call and is a silent no-op until `APP_HEALTH_INGEST_KEY` is set,
     so it is safe to merge first. Set `APP_HEALTH_ENVIRONMENT` to the
     environment name the product key should route to (default `production`).
3. Name events `noun` or `noun.verb`, lowercase: `signup`, `waitlist.join`,
   `payment.failed`. Put a short description in `title`, filterable fields in
   `props`. Never put secrets or tokens in a log.
4. Open the Logs tab and filter by level or event. For legacy operator-owned
   projects, Slack uses the
   `LOG_ALERT_WEBHOOK_URL` secret on the Worker; `LOG_ALERT_MIN_LEVEL` (var,
   default `info`) decides what gets posted. Account-owned projects never forward
   logs to this deployment-wide webhook. Workspace-owned destinations are not
   implemented yet.

### Hook points in the fleet

| Auth library         | Hook                                                        |
| -------------------- | ----------------------------------------------------------- |
| better-auth          | `databaseHooks.user.create.after`                           |
| Auth.js with adapter | `events.signIn` when `isNewUser`                            |
| Auth.js JWT-only     | select-before-upsert in `callbacks.signIn`, log when absent |
| Plain route handler  | `void ping('waitlist.join', …)` after the write             |

## Browser logs

Pages send logs with a **public key** (`ahk_pub_…`), created in the Logs tab
under "Browser logging keys". A public key is not a secret:

- it is pinned to one app environment and an **origin allowlist**; batches from
  any other `Origin` are refused with 403;
- it is **rate limited** to 600 logs per minute per key (429 beyond that);
- everything it sends is stored with `source: browser` and shown with a badge,
  so server facts and browser claims never blur together;
- by default browser logs only reach Slack at `error`; server logs at `info`.

Client options, all speaking the same `BrowserLogBatchV1`:

- bundled frontends: `createWebLogger` from `@saas-maker/app-health/web`;
- static sites (Astro landings, plain HTML): copy
  `examples/dropin-log-client/ping-web.ts`.

The key travels in the request body and the batch is posted as `text/plain`,
so browsers skip the CORS preflight and `navigator.sendBeacon` works on
`pagehide`. Keep money and account facts (signup, payment) on the server; use
the browser for what the server cannot see (a form opened then abandoned, a
client-side error, a CTA on a page with no backend).

## Routing

Every accepted log is matched against a list of routes; it goes to the union
of sinks from all matching routes. Sinks today: `store` (D1, what the Logs tab
reads) and `slack` (the incoming webhook). Defaults:

```json
[
  { "match": {}, "sinks": ["store"] },
  { "match": { "source": "server", "min_level": "info" }, "sinks": ["slack"] },
  { "match": { "source": "browser", "min_level": "error" }, "sinks": ["slack"] }
]
```

Override per deployment with the `LOG_ROUTES` var (JSON, `LogRoutesV1` in
`packages/contracts/src/log.ts`). `match` accepts `source`, `min_level`, and
`event`; a log matching no `store` route is accepted but not kept. Adding a
destination is a new `LogSink` value plus a delivery branch in
`apps/worker/src/log-routing.ts`; per-app routes stored in D1 are the natural
next step when one deployment serves several owners.

## Decisions

### 2026-09-05 Logs live in App Health, not a separate service

A standalone Worker (`ping`) was prototyped first: one D1 table, a Slack
webhook, a `/feed` page. It duplicated what App Health already had (per-app
ingest keys, D1, an owner-authenticated dashboard, an SDK, a Worker on the
ingest host). Folding it in reuses all of that and honours the fleet rule of
improving existing products rather than adding one.

### 2026-09-05 Logs are an explicit exception to the aggregate-only boundary

App Health's privacy promise is about endpoint telemetry: nothing is derived
from a request beyond method, route, status, duration, timestamp, release.
Logs are different in kind. They exist only when the owner's code calls
`log()`, and they carry exactly what that code passes. The boundary statement
was rewritten to say both things plainly instead of pretending logs are
telemetry.

### 2026-09-05 Same ingest key, separate route

`/v1/logs` authenticates with the product ingest key already in every app, so
adding logs to an app is a code change, not a key-management task. A separate
route keeps the strict `EventBatchV1` validator untouched and lets the two
payloads evolve independently.

### 2026-09-05 Insert first, alert after

The D1 write is awaited before the `202` so history is durable even when Slack
is down. Slack delivery runs in `ctx.waitUntil` so a slow webhook never slows
the sending app. A failed post is logged, not retried; the row is still in the
Logs tab.

### 2026-09-05 Thirty-day retention, hourly pruning

Failures keep 24 hours because they are high-volume and derived. Logs are
low-volume and hand-picked, so a month is enough to answer "what happened last
week" without an unbounded table. The existing hourly cron prunes both.

### 2026-09-05 Browser logs use a separate public key, never the ingest key

The ingest key is a bearer secret; a page cannot hold one. Public keys are
scoped (environment, origins), rate limited, and their logs are labelled, the
same model PostHog and Sentry use for client tokens. The key rides in the body
as `text/plain` so there is no preflight and `sendBeacon` can deliver the last
events of a session.

### 2026-09-05 Routing rules instead of a single alert threshold

The owner wants each log and level to choose its destination over time (Slack
for the important ones, other sinks later). Routes are evaluated per log and
decide even whether a log is stored; `LOG_ALERT_MIN_LEVEL` survives only as the
input to the default routes. Sinks are an enum in the contract so the
dashboard, worker, and docs stay in step when one is added.

### 2026-09-05 Drop-in client alongside the SDK

The Node SDK is installed from GitHub release tarballs, so the eight fleet
apps on Cloudflare Workers would each need a release bump to adopt `log()`.
A ~90-line zero-dependency file that speaks `LogBatchV1` lets them start now;
it is the same contract, so switching to the SDK later is a one-line change.

## Readiness verification — 2026-09-12

Log ingestion rejects events more than five minutes in the future or older than
30 days before consuming browser quota or writing data. Queries apply the same
clock and retention bounds, even if physical cleanup falls behind.

Server and browser batches use separate retry claims in the existing bounded
dedupe store. A repeated batch returns `accepted: 0` and its `duplicates` count,
with no repeated sink delivery while the claim is retained. Legacy clients
without batch IDs use a stable digest of log IDs. Individual stored log IDs
remain unique within the project/environment. Repacking logs into a different
batch is not a guarantee of external-sink idempotence; external alerts remain
best effort rather than an exactly-once delivery system.

Optional legacy webhook delivery has a two-second per-request timeout and a
ten-second batch budget. Failed or budget-exhausted deliveries are not retried;
stored logs remain available. Account-owned logs cannot reach the legacy global
webhook, and ownership lookup failures suppress external delivery.

The Logs dashboard validates response contracts, cancels obsolete reads, uses an
eight-second timeout, and clears mismatched filter results. It shows up to the
latest 200 matching logs; the API supports a maximum of 500. Pagination and raw
archive export are not implemented. Stored logs expire after 30 days.

The workerd canary exercises all four levels, scalar properties, server/browser
source labels, repeated batches and future timestamp rejection against actual
D1 storage. The Cloudflare checkout sample uses both server and browser log
clients. Unit tests cover retention clocks, failed-storage retry, external
delivery bounds and workspace isolation. Production activation and runtime SDK
qualification remain separate readiness stages.
