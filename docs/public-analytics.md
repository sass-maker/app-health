# Public live analytics

App Health can publish a read-only page for one project environment and embed
that page on the product's website. In **Project settings → Public live
analytics**, create a link, then copy either the public URL or the iframe snippet.
Visitors need no App Health account. The Projects overview separately links to
authenticated dashboards.

The public page shows the project and environment names, active browser and
opt-in native foreground sessions seen within 45 seconds, and web pageview totals
and hourly trends for the past 24 hours.
It never returns paths, referrers, named events, session IDs, logs, ingestion keys,
or another project's metrics. Sessions are not unique people. Unavailable data
shows an unavailable state rather than a manufactured zero; sampled traffic is
labelled as estimated.

## Links and embedding

Each link uses a dedicated, randomly generated read token. Only its SHA-256
verifier is stored. The token is revealed once and placed in the URL fragment,
which is not sent in the page request. The page sends it in an Authorization
header to the same-origin public API. It grants no dashboard or ingestion access.
Anyone who receives the link or reads a published iframe can view its aggregates.

Use **Revoke** beside a link to disable it. Every API read checks revocation and
current project ownership before reading metrics. Revocation blocks subsequent
reads immediately; an already open visible panel clears on its next refresh
(normally within ten seconds). Previously copied data cannot be recalled. Up to
five links can remain active per project environment; create a replacement and
update your website when rotating a link.

The generated iframe uses the dedicated `/live?embed=1` page. Add `theme=light`
to its query string for a light panel; dark is the default. Only `/live` permits
framing. Dashboard frame restrictions remain intact. The page and API request
no indexing and suppress referrers, and the API response is not publicly cached.
The embed loads a separate entry point that excludes the dashboard UI.

## Optional JavaScript viewer

Use the separate `@saas-maker/app-health/viewer` entry for a custom widget in
your product. This entry adds no ingestion SDK, framework or runtime dependency.
These changes are local and unreleased; use a locally built package until publication.

```ts
import { createAnalyticsViewer } from '@saas-maker/app-health/viewer';

const viewer = createAnalyticsViewer({
  origin: 'https://your-app-health-dashboard.example',
  token: 'ahs_REPLACE_WITH_TOKEN_FROM_SHARE_LINK',
});
const stop = viewer.subscribe((state) => {
  // Always replace the previous display, including paused/unavailable/closed.
  element.textContent =
    state.kind === 'ready'
      ? `${state.data.live.active ?? 'Unavailable'} live sessions`
      : state.kind;
});
// When the widget unmounts:
stop();
viewer.close();
```

`read()` makes a one-shot request; concurrent callers share an in-flight read.
`subscribe()` shares one polling loop across listeners, clears on hidden tabs,
and resumes with fresh data. Temporary failures clear the current display and
back off; a revoked link stops future reads for that client. Create a new client
when replacing the token. `close()` aborts requests, removes listeners and clears
the snapshot. Host callbacks are isolated. The SDK returns a validated aggregate
projection and never exposes additional response fields.

Only `/v1/shared/analytics` supports cross-origin aggregate reads and Authorization
preflight. Requests omit cookies, disable caching/referrers and reject redirects.
No owner or ingestion API gains CORS access. The token is intentionally public to
anyone who can inspect the widget; use a different link per placement to revoke it
independently. The real browser canary is `node scripts/verify-public-viewer.mjs`.

## Efficiency and operating limits

Visible panels poll every ten seconds, pause while the document is hidden, and
back off to at most once per minute after transient errors. Each request has a
ten-second timeout. Production reads use two indexed D1 queries for the token
and current project scope. Scope-specific internal caches reuse live counts for
ten seconds and the single hourly traffic aggregate query for sixty seconds.
Public readers do not open presence WebSockets or allocate one Durable Object
per viewer. Cache reuse is local to the serving Cloudflare cache, not global.

Traffic uses the existing retention and batch-ingest pipeline described in
[browser analytics](browser-analytics.md) and [efficiency](efficiency.md).
Publishing a panel still creates requests proportional to its visible audience;
these bounds are not a production load test or a billing guarantee.

## Verification and activation

The browser test sends actual local collector events, creates a share through
Settings, opens it anonymously and in a cross-origin iframe, checks the public
allowlist, and revokes the link while the iframe remains open. Screenshots cover
390, 768, and 1440 pixel widths in both themes. The workerd canary also checks
owner-only management, anonymous reads, revoked reads, and route-specific frame
headers. Unit tests cover token hashing, active-link limits, scope isolation,
ownership changes, provider validation, expiry, and polling cancellation.

This implementation is local and not deployed. Production activation requires
the existing accounts and browser analytics setup, additive migration
`0009_analytics_shares.sql`, and a deployed `/live` deep-link and embedding canary.
Local shares are in-memory and disappear when the local server restarts.
