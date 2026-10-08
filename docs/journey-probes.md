# Journey probes

Synthetic, complete-response checks of real production hostnames. They catch
the failure that passive server timing cannot: a backend answers HTTP 200 in
200 ms while users wait 8 seconds for the body, or cannot load the page at all
(sass-maker/app-health#175).

## What one run does

`node apps/probe/src/cli.ts --location <id>` runs every journey in the policy
file once, on a fresh connection each, then exits. A scheduler outside
Cloudflare invokes it every few minutes.

- **Complete response.** The deadline runs from request start to the last body
  byte. A fast-headers, slow-body 200 is a `timeout`; a truncated body is
  `incomplete`. Phases: DNS, connect, TLS, time to headers, body, total.
- **Usable result.** Status, content type, literal body markers and JSON
  invariants (`path` with `min_items` or `equals`). Page journeys also fetch the
  first same-origin script or stylesheet, so a page that never boots fails.
- **Cold and warm.** `warm_check` repeats the request; either over budget is slow.
- **Diagnosis only, no causation.** Numeric `Server-Timing` (backend time) and the
  `cf-ray` colo are recorded. A journey against the direct backend
  (`anime-search-backend`) next to the public one separates slow backend from
  slow delivery.

## Incidents

State lives in a local file (`--state`), one record per journey.

| Observation                                                         | Rule                                              |
| ------------------------------------------------------------------- | ------------------------------------------------- |
| Failed (timeout, incomplete, network, HTTP, parse, semantic, asset) | Opens a failing incident at once                  |
| Slow (complete, over `budget_ms`)                                   | Opens a degraded incident after two runs in a row |
| Healthy                                                             | Recovers an open incident after two runs in a row |

An incident keeps one id until it recovers, so repeated bad runs send nothing
new. Degraded escalates to failing under the same id. Logs are sent only on a
transition: `journey.failed` (error), `journey.degraded` (warn) or
`journey.recovered` (info). These need no organic traffic, unlike the
20-request endpoint health minimum.

If every journey fails at DNS, connect or the network, the **vantage** is
offline. No product incident opens; the heartbeat says `vantage_offline`.

If delivery to App Health fails, transitions stay queued (at most 90) and
retry with the same log ids. The collector deduplicates them.

## Monitoring the monitor

Each run sends one `probe.heartbeat` log at `debug`. That level keeps it out of
default Slack routes. The owner alert feed (`GET /v1/workspace/alerts`) returns
`probes`: each location's last heartbeat, marked `stale` after three missed
intervals. An empty list renders as missing journey coverage, never healthy.

## Privacy

Props are a fixed allowlist: catalog project id, journey id, incident id,
location, outcome, failure class, HTTP status, budget, phase timings in ms, the
backend `Server-Timing` number and the edge colo. URLs, query values, bodies,
headers, cookies and identities are never sent. Journey URLs reject query
strings and credentials. POST journeys send only a fixed public fixture.
Synthetic activity is not analytics traffic, so it never inflates engagement.

## Running it

- **Dry run.** Without `APP_HEALTH_INGEST_KEY` it prints the results and the
  logs it would send, and writes no state.
- **Live.** Set `APP_HEALTH_INGEST_KEY` to the App Health production ingest key.
  `props.project` attributes each incident to its catalog project, the same way
  SaaS Maker attributes feedback. `APP_HEALTH_LOGS_URL` overrides the endpoint.
- **Vantages.** Use the owner's machine for India and local networks
  (`--location india-home`), plus an independent remote runner where one exists.
  A single overseas runner, or a probe inside Cloudflare, cannot show
  user-network health. A location that is not provisioned is missing coverage.

`apps/probe/pilot-journeys.json` is the pilot policy: App Health landing, the
API and ingest health checks, and the Anime List home page, anime search
(public and direct backend) and manga search. Budgets: 2 s for pages and
anime search, 3 s for manga (provisional), 1 s for health. The policy for the
rest of the Fleet should be generated from the SaaS Maker catalog and passed
with `--config`.
