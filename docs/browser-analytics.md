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
  data-project="YOUR_PROJECT_ID"
  data-identity="persistent"
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
breakdowns. Reports support project/environment filters and 1-hour, 24-hour, 7-day and 30-day periods. Visitor recognition, campaign and technology reports are described in [analytics identity](analytics-identity.md); this extension is local and unreleased.
Local development uses real collector requests and an in-memory
store with a five-second workspace poll. Restarting local Vite clears that data.

To publish aggregate live counts on a product website, use
[public live analytics and embeds](public-analytics.md).

### Web vitals

Add `data-vitals` (empty, `"1"`, or `"true"`) to the tracker tag to opt in.
When its script URL ends in `/tracker.js`, the tracker lazily loads `/vitals.js`
from the same host (beside `/tracker.js`);
`vitals.js` is a separate opt-in static file with no runtime dependencies.
The tracker gzip budget rises from 3250 to **3400 bytes** for the small loader (about 180 bytes); the vitals code itself stays out of the tracker. Vitals emit one `web.vitals`
log per document, sent on the first hidden transition or pagehide. Optional
`data-vitals-sample="0.1"` samples once per document; values must be in (0, 1],
with missing or invalid values defaulting to 1. Webdriver and documents with
no captured metrics send nothing; restoring from bfcache starts no new report.

The debug-level log sends supported LCP, INP and TTFB in milliseconds, CLS ×
1000, navigation type, and a lowercased first path segment (root or `/other`
for invalid segments or concrete IDs). It includes no query, hash, host, or
analytics identity. The first path segment is what pageview paths already carry; products whose first segment can be an identifying slug set `data-vitals-routes="docs,pricing"` so every other segment becomes `/other`. INP uses the browser's `performance.interactionCount` when available, so slow-event-only observation does not skew the 98th percentile. Prerendered documents are timed from activation, and LCP entries painted after the tab was first hidden are ignored. If `stop()` runs while `vitals.js` is still loading, vitals never start. It reaches the Logs store only, never Slack; performance
reports and product wiring remain separate work. The same public key must be
accepted for browser logs with the page's Origin allowed. `data-vitals-endpoint`
overrides the logs endpoint; otherwise trailing `/v1/browser` becomes `/v1/logs`
(default `https://ingest.sassmaker.com/v1/logs`). Delivery uses a text/plain
beacon with a credential-free keepalive fetch fallback; `stop()` removes vitals
observers and listeners too.

## Semantics and privacy

- Persistent anonymous visitors are the default for new installations. IDs stay in
  first-party local storage for up to 90 days, scoped by `data-project`; visits
  expire after 30 minutes without a pageview or explicit product event. Same-origin
  tabs share the visit. Web Locks serialize identity changes where supported, so
  simultaneous tabs do not create separate visitors. Without Web Locks, storage
  sharing is best-effort and simultaneous creation can race. Heartbeats do not
  prolong inactivity or create historical events; expired visits stop sending
  idle heartbeats. Scrolls and pointer movement alone do not extend a visit.
- `data-identity="session"` omits persistent visitor IDs. Blocked storage falls
  back to an in-memory session. Raw session and visitor IDs are hashed with the
  app/environment scope before queueing or archival. Legacy identity remains
  unknown, never counted as a new visitor.
- Historical visitors describe recognized browsers, not unique people. Distinct
  counts cover the whole selected period. Sampled results are lower bounds for
  visitors and sessions, never extrapolated as unique people.
- Active means a heartbeat within 45 seconds. The Durable Object prunes on
  ten-second alarms; a connected dashboard can observe expiry up to ten seconds
  later. Delayed event batches older than this presence window are still stored,
  but do not revive an old online session. A fresh empty heartbeat can update
  presence without adding historical events. Disconnected production counters
  display a dash until reconnection.
- Automatic paths omit query strings and fragments and redact segments with
  digits, email delimiters, whitespace, or long values. Referrers contain only
  the hostname. Bounded campaign tags and coarse country/device/browser categories
  support acquisition reports. No cookies, request bodies, raw IP addresses or
  raw user-agent strings enter analytics storage. Path redaction is heuristic: only install on suitable public
  routes, and do not put private values in manual names or paths. This does not
  claim automatic removal of every possible identifier in a slug.
- Public keys are bound to project, environment, and allowed Origin, and are
  revocable. Origin checks constrain ordinary browsers; a public key is not
  proof that a request came from a genuine human. Counts are not billing records.
- Workspace scope comes from authenticated D1 ownership, never a browser-supplied
  workspace ID. Legacy deployment-key owners cannot query account workspaces.

## Delivery and efficiency boundaries

### Server-side bot filtering

The production Worker ignores recognized bot batches using trusted
Cloudflare verified-bot metadata or the pinned `isbot` user-agent matcher. This
runs after payload, timestamp, public-key, and Origin checks, and before quota,
session/presence, queue, archive, D1 visitor-ledger, or capability updates. The
user-agent is inspected transiently and is never stored. Missing user-agent
values and ordinary browsers keep the current acceptance path. Endpoint health
continues to measure all HTTP requests; explicit application logs and feedback
are unchanged. Filtering reached 100% on October 1, 2026 at 06:25:40.421 UTC. Rejected bot batches are not retained, so the dashboard cannot query a Bots total or retroactively reclassify old events. The first
complete India calendar day after activation is the earliest bot-filtered
visitor qualification candidate; historical days, including October 1, are not
retroactively classified.

The standalone tracker has no runtime dependencies and a tested **3400-byte gzip**
budget. It queues at most 100 events, sends at most 25 per batch, flushes after
1.5 seconds, and reuses its batch ID on retry. A request times out after ten
seconds; retryable failures get at most three attempts with backoff. Permanent
4xx responses drop that batch. Navigation beacons are best effort and do not
count as acknowledgements. Events can still be lost if the page closes offline.

`POST /v1/browser` bounds the body to 32 KiB and 25 events, checks timestamps,
validates the public key and origin, and limits each key to 6,000 event/heartbeat
units per minute. Production awaits Queue acceptance before returning 202 for
non-empty batches, then commits recognized visitor/day facts and a scoped batch
receipt to D1 before returning 202. A D1 failure returns 503 even if Queue
accepted the message; that attempt is not represented in the exact set. Batches
without a visitor hash do not create a visitor or a D1 visitor receipt.
Heartbeats never enter the queue or archive.

Migration `0019_browser_visitor_days.sql` adds one row per scoped visitor hash,
environment, and India calendar day, plus bounded batch receipts. Event dates
use `[start, end)` UTC bounds for Asia/Kolkata days, so late arrivals repair the
original day. The provisional retention is 35 days after day end and receipts
expire 35 days after acceptance; scheduled cleanup deletes at most 10,000 rows
from each table per hourly run and logs whether an indexed backlog remains.
Exact daily reads use one grouped D1 query capped at 128 app/environment scopes.
Confirm the 35-day product lookback and D1 row growth before production release;
the time bound is finite, but row volume and cost still scale with traffic.

The exact reader returns Unknown until a sealed per-app production day has a
continuous tracker activation, the Worker release is proven at 100% traffic,
and workspace rollout plus app-scope audits cover the complete late-event
closure window. Missing, stale, overlapping, or interrupted proof remains
Unknown; a sealed zero is meaningful only after these checks pass. The
acceptance ledger is independent of Queue/R2 archival reconciliation: it counts
visitor facts only for batches whose D1 acceptance transaction completed before
the 202 response. Hashless accepted batches do not increment visitor counts.
The Daily briefing remains on its existing Analytics Engine path until its
consumer is separately qualified to use sealed D1 results.

Migrations `0025_browser_visitor_acceptance_coverage.sql` and
`0026_browser_visitor_day_seals.sql` must be applied in order before deploying
Worker code that reads or writes acceptance coverage or day fences. An
authenticated full workspace owner can submit one bounded proof action at a time to
`POST /v1/browser/visitor-coverage`; the endpoint derives workspace identity
from the owner session, enforces same-origin requests and production app scope,
and accepts only IDs, timestamps, source SHAs, and evidence SHA-256 digests.
Keep the provider exports and their exact source/time/redaction notes in the
private operator record; never send raw exports, credentials, or secret values
to this endpoint. Record each rollout start before treating it as coverage,
confirm its exact version/source SHA only after provider traffic reports 100%,
and record tracker activation/deactivation and both audit watermarks from
reviewed provider evidence. Seal a day only after its end plus 24 hours and the
settlement grace. A later rollout invalidates future seals when it interrupts
the audited interval; already sealed days remain immutable. No production
cutover, backfill, or exact-count claim is implied by the migration or code.

Queue consumers route batches to one of 16 stable per-workspace archive shards.
Each shard durably stages accepted batches in SQLite before the Queue message is
acknowledged. It seals JSONL into gzip-compressed segments at 1 MiB or after a
time alarm, then retries an immutable R2 object. Batch identity is deduplicated
for 31 days; pending batches, bytes, stage size, and ledger rows are bounded.
Duplicate deliveries do not project the batch again. R2 uploads supply a SHA-256
checksum. If a conditional upload finds an existing object after a lost response,
the archiver verifies its length and hashes the stored bytes before releasing
staged facts. Missing, unreadable, or conflicting objects retain staging and retry;
they cannot silently become successful archival receipts. Verification reads at
most one bounded segment and does not authorize source deletion or compaction.
The Durable Object exposes an indexed lookup for up to 100 scoped batch
identities per call; the Queue helper routes up to 1,000 D1 acceptance identities
to those same stable shards in groups of at most 100. A hit means the matching
identity remains in the shard's bounded SQLite dedupe ledger after stage commit.
Pending rows remain visible while R2 retries; successfully archived rows remain
visible for the 31-day dedupe window, then lookups report them missing. The result
contains app, environment, and batch IDs only. It proves a local stage receipt,
not Queue/DLQ exhaustion, successful R2 archival, or day completeness.
After staging, the Queue consumer also stores an identity-only D1 receipt before
acknowledging the message. A D1 write failure retries the message; redelivery
safely repeats staging and the receipt write. Receipts expire on the existing
35-day visitor-ledger schedule. They are not backfilled: batches whose Queue
delivery completed before migration `0023_browser_queue_stage_receipts.sql` was
applied remain unobserved, even when their archive facts match. Audit counts
report `queue_stage_receipts` and `queue_stage_unobserved`; unobserved is not
proof of delivery failure. A stage receipt proves only that the consumer staged
the batch and committed its identity to D1. It does not prove R2 archival, an
empty Queue or DLQ, provider retention, or a complete India-day window. Audits
remain `complete: false` and do not set a report watermark.
R2 is authoritative;
Analytics Engine is an eventually available, best-effort sampled projection,
queried with `_sample_interval` weighting. A durable bounded outbox retries failed
projections independently of archival. A crash after append but before clearing
the outbox can still duplicate an analytical projection. Queue replay/export
and production completeness reconciliation are not implemented. This is not
exactly-once end-to-end analytics.

### Offline receipt-to-archive comparison prerequisite

`readBrowserVisitorReceiptPage` is the bounded D1 selector for one India event
day. It pages in stable app/environment/batch order, accepts at most 128 scopes
and 500 rows per page, and returns the v1 facts digest alongside the receipt;
legacy null digests stay null. `reconcileBrowserArchiveDay` compares up to
10,000 selected D1 receipts and archived facts, with no more than 8 MiB of
aggregate canonical serialized facts and 25 events per archived batch. The
byte cap is checked for every selected fact before any digest is computed; an
over-cap input throws and must be reported as incomplete by the caller. It
recomputes each archived fact digest and reports matches, missing archive facts,
legacy receipts, missing archive digests, mismatches, duplicate facts, and
archive facts without a D1 receipt. Its overall result remains incomplete when
the R2 lookup is incomplete, D1 or R2 retention is expired/unknown, or Queue
and DLQ reconciliation are pending/unverified. This is a pure offline
comparison prerequisite: callers must verify object bytes/manifests and must
include archive candidates with the same batch identity even when changed event
timestamps place them outside the selected day. The result must not be
interpreted as a production coverage watermark.

Each archive shard now has a bounded event-day index and batch-to-segment
lookup. `auditBrowserArchiveDay` acquires the selected D1 receipt pages,
queries all 16 shard indexes, follows up to 100 bounded batch-index lookups, fetches
referenced R2 objects, verifies manifest metadata and bytes, extracts facts,
and calls the comparator. It caps receipt reads at 10,000, batch-index fallback
lookups at 100 with at most 25 concurrent DO calls, unique segments at 5,000,
compressed and decompressed bytes at 64 MiB and 8 MiB globally, and 10,000
archive facts. Per-object compressed and decompressed limits are 2 MiB. Any
cap returns explicit reason codes; skipped batch-index identities are counted
as unverified and excluded from observed comparison counts. These counts
describe only acquired, verified facts; `no_archive_candidate` is not proof of
absence if another page/object failed or retention is unknown. The result
contains aggregate counts only and never returns raw receipt identifiers,
visitor hashes, or event fields. Snapshot
exhaustion is not a Queue/DLQ barrier or current-state completeness proof.
Queue/DLQ delivery and provider-retention evidence remain external and are
unavailable to this offline helper, so it always returns incomplete. No
production watermark or Daily briefing fallback is enabled.

### Resumable owner audit jobs

An authenticated full-workspace owner can start one bounded observation with
`POST /v1/browser/archive-audits?day=YYYY-MM-DD` and poll
`GET /v1/browser/archive-audits/<job_id>`. The request contains no workspace or
product selectors; both are taken from owner authentication. The worker runs
at most one job globally and three bounded D1/DO/R2 slices per hourly
scheduled invocation. Starting another workspace's job while one is active
returns 409 and does not enqueue a job or start its retention clock. This
admission cap prevents queued workspaces from silently expiring behind a
long-running maximum-size job. It caps
each receipt page at 30 rows, each event-day index page at three segments, the
per-slice archive fact work at 39 facts, and each job at 10,000 fact identities
and 5,000 segments. An uninterrupted run at both hard caps can take about 11
days (10,000 receipt rows at 90/hour plus 5,000 segment references at 36/hour);
the 14-day active-job expiry leaves room for a small amount of scheduling
delay. A five-minute D1 lease serializes concurrent scheduled deliveries; all
slice writes require the active lease token, and a crashed invocation becomes
eligible for retry after the lease expires. A cap or repeated provider failure
ends the job incomplete. Expired active jobs also become inspectable incomplete
jobs with an explicit `audit_job_expired` reason. Terminal status and salted
identity-key digests are retained for 24 hours, then D1 cleanup physically
removes them independently of DO/R2 binding availability. Status exposes
aggregate counts and progress only.

Every result has `complete: false`. A finished job means only that its captured
D1 rowid range and per-shard index snapshots were read within the limits. It
does not prove a global snapshot barrier, all archive candidates for a batch,
Queue/DLQ exhaustion or replay, provider retention, unsampled Analytics Engine
parity, or production cutover. The one-candidate batch lookup and all external
gates remain explicit incomplete reasons. The job never writes visitor
coverage metadata and is not consumed by the Daily briefing.

New segments also carry the versioned archive manifest in R2 custom metadata,
committed atomically with the gzip bytes. It records the compressed-content
SHA-256, batch and event counts, actual UTF-8/compressed byte lengths, workspace,
and minimum/maximum event timestamps. These are event-time bounds, including
late events, rather than the upload partition date. The manifest remains
`active`; writing it does not claim compaction, reconciliation, or D1 indexing.
Existing immutable segments without this metadata remain readable and are not
rewritten by retries. Their inventory/backfill is a separate operation.

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
for 60 seconds. A report queries core metrics and only the selected group of
audience, acquisition, or technology dimensions; the summary makes one additional
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
4. Bind `BROWSER_HISTORY` to R2 without an age-based object lifecycle. The
   current application authorizes no source deletion; a future compactor must
   verify cryptographic and content equivalence before replacing any source.
   Bind `BROWSER_ANALYTICS` to the `app_health_browser_v1` Analytics Engine
   dataset. Existing account ID and query-token bindings must authorize that
   dataset.
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

Remaining product work in #58 includes richer filtering, a dedicated bot report, funnels,
revenue/payment attribution, exports/replay, alerting, and full DataFast parity.

## Source, country, and session reporting

Reports group common referral domains (including Reddit and X link shorteners)
before applying the top-20 limit. The browser captures the external referrer
without requiring UTMs and retains it across internal navigation in the session.
Explicit UTM attribution still takes precedence. Missing referral evidence is
reported as Unknown; apps that strip referrers cannot be reliably reconstructed.
Arbitrary campaign source labels are preserved apart from case normalization.
An expired visit resumed in the same document, reloaded, or restored from history
must not inherit the document's old external referrer or campaign. A fresh external
navigation can establish a new source. An explicit empty session source takes
precedence over event referrers in both local and production reports; historical
rows without session attribution retain their legacy fallback.

`apps/web/e2e/tracker-sessions.spec.ts` exercises normal anchor clicks from
controlled Reddit, X-shortener and Google source documents, a real HTTP 302,
no-referrer policy, internal navigation, reloads, simultaneous tabs and returning
visits against the local collector and reports. These are browser behavior tests,
not proof that every social platform or mobile app supplies a referrer. The tested
redirect preserves the browser source without extra landing-request cookies;
there is no demonstrated need for an edge fallback in this change. A stripped
referrer cannot be recovered by reading the destination request's Referer header.

The tracker remains dependency-free with a 3400-byte gzip budget (3250 plus the opt-in vitals loader).
The opt-in `vitals.js` (about 2.9 KB gzip) is served separately and only loaded on request. Delivery is bounded to
100 queued/waiting events, 25 per batch and three fetch attempts; retries keep
stable batch/event IDs. Storage restrictions prevent reliable cross-tab or
returning-visitor recognition, and browser termination can prevent final delivery.
Identity is first-party and origin-scoped; it does not join people across devices
or different domains.

Countries appear in the default audience view and optionally in public reports.
They come from Cloudflare request metadata already projected at ingestion, never
from client-submitted location or an extra geolocation service. Only coarse country
codes are stored; this adds no raw-IP storage or per-event lookup. A VPN's exit
country can differ from the visitor's physical location.

Owner reports additionally show pages per session, single-page bounce rate,
observed visit duration, and exit pages. Only sessions with a pageview contribute.
Duration is the span between first and last recorded events within the selected
window; a single-event visit has zero observed duration. This is not reading time,
and ongoing visits and window boundaries limit the observation. Exit pages use the
last observed pageview; simultaneous pageviews may tie. Sessions are scoped to
project and environment. Sampled results suppress engagement figures rather than
claiming exact per-session behavior. Event-specific reports omit these metrics.

The default audience adds one bounded country aggregate; engagement adds two
aggregate queries over grouped sessions, without transferring raw events to the
Worker. Failed engagement queries leave the core report available. Existing
retention, batching, and report cache behavior remain in place. These reporting
extensions are local and unreleased.

## Explore a segment

On the signed-in dashboard, click a country, source, page, entry page, device,
browser, channel, or campaign value to narrow the report. Different dimensions
combine with AND; clicking another value for the same dimension replaces it.
Remove a chip to broaden the selection or use Clear all filters. Period and
breakdown changes preserve the selection; changing project or environment clears it.
Country chips show readable names while requests use the original country codes.

The owner report endpoint accepts these optional exact-match query parameters:
`country`, `source`, `path`, `entry_path`, `device`, `browser`, `channel`, `campaign`.
For example, `country=IN&source=Reddit&device=Mobile` selects matching events.
The same predicates apply to previous-period comparison, trends, totals, and
rankings. Known sources use the same canonical grouping as the source table.
`source=Unknown` selects missing attribution; lowercase `source=unknown` selects
a campaign literally labelled unknown. Unknown connection/device metadata is
coalesced consistently between local and provider reports.

These are event filters, not whole-session membership queries. Presence remains
project-wide and is explicitly labelled. Session engagement is omitted while any
segment filter is active, because filtering out pages would distort bounce rates,
visit duration, and exits. Empty segments offer filter recovery, not installation
instructions. Pending responses from an old selection cannot replace the new report.

Filters reuse existing projected columns, query calls and the scoped bounded
report cache. No ingestion, raw storage, dependency or retention changes are needed.
Public shares remain aggregate-only and do not accept these owner filters. This
filtering extension is local and unreleased.

## Campaign details and comparisons

Acquisition includes campaign names, channels, medium (`utm_medium`), content
(`utm_content`) and terms (`utm_term`). Source rankings still work from referrers
without UTMs. Only nonempty campaign values appear in these tables; untagged
traffic remains included in overall totals. Click a value to filter, or use the
owner query parameters `medium`, `content`, and `term`. These combine with the
other exact-match filters and apply to the previous period too.

This reads existing `blob11`, `blob18`, and `blob19` projections. It adds three
bounded ranking queries only to the Acquisition tab; other breakdowns and public
sharing do not query them. There is no new ingestion or storage cost.

Main pageview, product-event, session and visitor cards compare against the
immediately preceding equal-length period with the same filters. A zero baseline
shows no previous activity instead of infinite growth; two zeros show no change.
Weighted sampled event comparisons are labelled estimated. Comparisons of sampled
unique counts are withheld because independent samples do not establish changes
in actual sessions or visitors. Live presence has no historical comparison.
These reporting extensions remain local and unreleased.
