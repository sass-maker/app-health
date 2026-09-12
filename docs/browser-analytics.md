# Browser analytics and workspace presence

Local implementation for [App Health #58](https://github.com/sass-maker/app-health/issues/58).
App Health is the Fleet product. Site Health remains Fleet's internal dashboard.
This extends the existing endpoint health and structured logging system; it does
not replace either. No Cloudflare resources or production configuration have
been changed for this implementation.

## Install and use

Sign in, add a project and environment, then open **Project settings** and
create a browser key with the exact origins of your website. The one-time key
reveal includes the script snippet:

```html
<script
  defer
  src="https://YOUR_APP_HEALTH_HOST/tracker.js"
  data-key="YOUR_PUBLIC_BROWSER_KEY"
  data-endpoint="https://YOUR_INGEST_HOST/v1/browser"
></script>
```

The script sends the initial page view, SPA pathname changes, and a heartbeat
while the document is visible. After it loads, `window.appHealth.track('signup.completed')`
sends an explicit named analytics event. `page('/pricing')` supports manual
page views; `diagnostics()` reports acknowledged, dropped, retried, and queued
events; `stop()` removes the tracker and its history hooks. A TypeScript global
API declaration is available beside the script. Use the existing
`createWebLogger` for structured log properties; the lightweight analytics
contract deliberately accepts names only.

**Web analytics** is the default dashboard, with active browser sessions, page
views, trends, top pages, and referral sources. **Events** shows explicitly named
events, occurrence counts, last received times, and per-event trends and page/source
breakdowns. Reports support project/environment filters and the last hour or day.
Local development uses real collector requests and an in-memory
store with a five-second workspace poll. Restarting local Vite clears that data.

To publish aggregate live counts on a product website, use
[public live analytics and embeds](public-analytics.md).

## Semantics and privacy

- Counts represent browser sessions, not people. Session IDs are random, stored
  in sessionStorage, and rotate after 30 minutes without tracking activity or
  at a UTC date boundary. Visible heartbeats keep a session active. The same
  visitor can have multiple sessions across tabs, devices, and projects.
- Historical session counts persist only a one-way SHA-256 hash scoped to the
  app, environment, and session. Raw browser session IDs are used transiently
  for the live heartbeat and never enter the queue or archive. Events collected
  before session-hash support have no historical session count.
- One-hour and 24-hour historical session counts are distinct browser-session
  counts, never unique-person counts. Sampled Analytics Engine results report a
  lower bound for sessions; they are not extrapolated to claim unique people.
- Active means a heartbeat within 45 seconds. The Durable Object prunes on
  ten-second alarms; a connected dashboard can observe expiry up to ten seconds
  later. Disconnected production counters display a dash until reconnection.
- Automatic paths omit query strings and fragments and redact segments with
  digits, email delimiters, whitespace, or long values. Referrers contain only
  the hostname. No cookies, request bodies, headers, or browser identity fields
  are collected. Path redaction is heuristic: only install on suitable public
  routes, and do not put private values in manual names or paths. This does not
  claim automatic removal of every possible identifier in a slug.
- Public keys are bound to project, environment, and allowed Origin, and are
  revocable. Origin checks constrain ordinary browsers; a public key is not
  proof that a request came from a genuine human. Counts are not billing records.
- Workspace scope comes from authenticated D1 ownership, never a browser-supplied
  workspace ID. Legacy deployment-key owners cannot query account workspaces.

## Delivery and efficiency boundaries

The standalone script has no runtime dependencies and a tested **2 KB gzip**
budget. It queues at most 100 events, sends at most 25 per batch, flushes after
1.5 seconds, and reuses its batch ID on retry. A request times out after ten
seconds; retryable failures get at most three attempts with backoff. Permanent
4xx responses drop that batch. Navigation beacons are best effort and do not
count as acknowledgements. Events can still be lost if the page closes offline.

`POST /v1/browser` bounds the body to 32 KiB and 25 events, checks timestamps,
validates the public key and origin, and limits each key to 6,000 event/heartbeat
units per minute. Production awaits Queue acceptance before returning 202 for
non-empty batches. An unavailable presence service does not undo accepted
events. Heartbeats never enter the queue or archive.

Queue consumers route batches to one of 16 stable per-workspace archive shards.
Each shard durably stages accepted batches in SQLite before the Queue message is
acknowledged. It seals JSONL into gzip-compressed segments at 1 MiB or after a
time alarm, then retries an immutable R2 object. Batch identity is deduplicated
for 31 days; pending batches, bytes, stage size, and ledger rows are bounded.
Duplicate deliveries do not project the batch again. R2 is authoritative;
Analytics Engine is an eventually available, best-effort sampled projection,
queried with `_sample_interval` weighting. A crash between SQLite stage and the
Analytics Engine write, or a partial projection failure, can undercount the hot
view. Replay/export and reconciliation tools are not implemented yet. This is
not exactly-once end-to-end analytics.

One SQLite-backed Durable Object coordinates each workspace. It stores only
active opaque session hashes and app/environment IDs, with a 20,000-session
limit and at most 1,000 simultaneously active project/environment scopes. New
scopes beyond that bound reject presence updates without undoing accepted events.
One authenticated read-only WebSocket serves all projects, uses
hibernation, and sends a frame only when counts change. At most 20 dashboard
connections are accepted per workspace. Connections get a 60-second auth lease
and reconnect through the authenticated Worker; alarm scheduling can extend the
lease by at most ten seconds. Logout closes the current UI connection; other
connections lose access at their next lease renewal.

The production dashboard refreshes its workspace summary and current report
once per minute and uses that one stream for live presence. Reports are cached
for 60 seconds. A report makes five bounded aggregate queries for trends, pages,
sources, named events, and distinct sessions; the summary makes one additional
aggregate query. Changing a filter requests a new
report. Every query is scoped to the authenticated workspace, with 24 trend
buckets, 20 pages/sources, and up to 100 event names. The existing project-inventory
refresh continues separately. There is no per-project analytics polling fanout.
These are code-level budgets, not a production load or cost benchmark.

Dashboard reads validate response contracts, time out after eight seconds and
abort when hidden or obsolete. Summaries and reports both exclude future events
and use a half-open event-time range. The Cloudflare sample verifies exactly one
automatic pageview and one named checkout event, event-filtered breakdowns and
isolation between production and staging.

## Production activation still required

Only an explicitly authorized deployment may activate this slice:

1. Complete account activation in [accounts.md](accounts.md), including Google
   callback verification and the additive account schema migration.
2. Switch the Worker entry to `src/analytics-entry.ts`. It retains existing
   fetch and scheduled cleanup handlers and adds the Queue consumer and
   `WorkspacePresence` export.
3. Bind `WORKSPACE_PRESENCE` to the SQLite Durable Object class, with the required
   new-SQLite-class migration. Bind `BROWSER_EVENTS` to its Queue producer and
   consumer, with bounded retries and a dead-letter queue. Configure alerts and
   a replay policy before relying on stored history.
4. Bind `BROWSER_HISTORY` to R2 and apply a 30-day object lifecycle. Bind
   `BROWSER_ANALYTICS` to the `app_health_browser_v1` Analytics Engine dataset.
   Existing account ID and query-token bindings must authorize that dataset.
5. Deploy the dashboard assets including tracker.js and run a real Google
   callback, two-account isolation, multi-project tracker, expiry, retry, and
   revocation canary. Check actual event projection latency and resource costs.

Missing analytics bindings fail closed with 503. The normal production config
still points to the previous entry and is unchanged. Local runtime tests use
synthetic sessions and temporary resources; they do not prove Google callback,
live Cloudflare Analytics Engine ingestion, production capacity, or deployment.

## Verification

Use Node 24 for this workspace: the installed Wrangler/Miniflare require Node
22 or newer, and CI now selects Node 24. The published Node SDK runtime contract
is unchanged. `pnpm run check` includes contract, tracker, UI, D1 isolation, SQLite presence,
and adapter tests, plus a credential-free real workerd canary. The runtime
canary exercises queue consumption, conditional R2 archive creation, live
WebSocket upgrade, same-origin enforcement, and authenticated ownership.
Browser evidence is in `.fleet/evidence/analytics/`; the populated screenshots
use actual local collector events from two projects, not fixture metric counts.

Remaining product work in #58 includes longer-range reports, richer filtering, funnels,
revenue/payment attribution, exports/replay, alerting, and full DataFast parity.
