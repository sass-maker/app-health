# Real-services proof — PRD 5

Milestone from the concise PRD in
[#58](https://github.com/sass-maker/app-health/issues/58): prove migrations,
catalog ownership, and archive/retry behavior on one owner-selected existing
service end to end, then a second independent consumer. This document selects
the consumers, freezes the budgets, records the isolation verification, and
defines the approval-gated production activation and canary plan.

**Boundary:** nothing here is a deploy, migration, or release approval.
Production activation requires the explicit owner approvals listed under
[Approval gates](#approval-gates). Capability states must keep distinguishing
implemented, activated, and observed; a merged route is implemented, not
proven.

## Consumers

### Consumer 1 — Free AI (endpoint + manual log)

- Live Worker `free-ai-gateway` at `ai-gateway.sassmaker.com`; catalog id
  `free-ai`; P4 toolbox, `required-service` auth.
- Runs entirely on free tiers across ~11 providers and 80+ models, so it is a
  real always-on service whose provider-fallback traffic produces genuine
  endpoint signal — and onboarding it adds zero consumer-side cost.
- Already carries `@saas-maker/app-health` 0.2.1 with the `hono` adapter wired
  through `getAppHealthClient`, gated on the runtime-only
  `APP_HEALTH_INGEST_KEY` binding. Activation is a secret set plus Free AI's
  manual `cloudflare-deploy.yml` dispatch — no new consumer code path.
- Concrete questions: which gateway routes error or degrade under real
  provider-fallback traffic, and does endpoint health explain user-visible
  failures faster than the gateway's own analytics?
- Scoped onboarding: endpoint ingest only. A single owner-authored
  `client.log()` milestone (for example `app-health.activated` on first
  receipt) is optional and stays out of request traffic.

### Consumer 2 — SaaS Maker (browser + archive)

- Live worker+pages product at `sassmaker.com`; catalog id `saas-maker`;
  real anonymous public traffic, which endpoint-only Free AI cannot produce.
- Concrete questions: how much real traffic does the public directory get,
  which pages and sources matter, and does the durable browser archive
  survive the real pipeline without count inflation?
- Scoped onboarding: public key bound to the exact `sassmaker.com` origin,
  the existing tracker/snippet in the site shell, and one owner-authored
  server log on an existing meaningful action (feedback submission), via a
  small change in the SaaS Maker repository — not this one.
- Owner may substitute another live browser surface; the acceptance criteria
  below do not change.

### Explicit non-consumers

App Health's own project is already dogfooded and is not independent proof.
Fleet-wide rollout, additional consumers, and analytics parity remain
excluded per the PRD.

## Frozen budgets

### Privacy

- Endpoint contract unchanged: method, normalized route, status, duration,
  response bytes, timestamp, optional release. No headers, cookies, query or
  route-parameter values, bodies, identity, stacks, or spans.
- Browser collection unchanged: anonymous aggregate sessions, project/
  environment-scoped hashes, public key required with origin allowlist equal
  to the consumer's exact production origin.
- Logs remain explicit owner-authored events only; nothing derived from
  request traffic. 30-day bounded retention.
- Catalog import sends only curated declaration fields (`catalog_id`, `name`,
  `lifecycle`, optional public `repository`/`hostname`) — never a wholesale
  private catalog and no provider credentials.

### Load

- No synthetic load beyond the canary events listed below. Ambient real
  traffic is the measurement, not generated volume.
- SDK defaults bound batch sizes and retries; Free AI delivery runs in
  `waitUntil` and adds no request-path latency budget beyond the existing
  middleware.

### Query

- Reads use existing dashboard/owner API surfaces only; no new polling
  loops, no per-project analytics fanout.

### Cost

- No new Cloudflare subscription or resource family. Incremental footprint:
  ≤ 10 `catalog_project_imports` rows, per-batch dedupe rows, WAE datapoints
  per accepted batch, R2 segments only from real archived browser data on
  the existing hourly cron (`17 * * * *`), existing queue/DLQ.
- Measure: snapshot Workers requests, D1 read/write rows, WAE datapoints,
  R2 objects/storage, and queue operations before activation and after a
  7-day window; report deltas in the receipt. Expected incremental cost
  under $1/month at current traffic; a higher projection pauses the
  milestone for owner review.

## Acceptance criteria

Pass only when all hold in production for each consumer:

- **Counts:** accepted totals equal emitted totals exactly; deliberate
  duplicate batches and queue redeliveries do not inflate counts.
- **Freshness:** endpoint receipts visible within 5 minutes of flush
  (existing canary bound is 60s); browser page views and named events
  visible within one report-refresh cycle of queue drain; log receipts
  within 60s. Record actuals.
- **Isolation:** a second account cannot read, key, or import onto the
  consumer's project; unauthenticated requests are denied.
- **Durability:** acknowledged data survives a Worker redeploy and a
  scheduled archival; each produced R2 segment carries a manifest whose
  SHA-256 checksum, scope, and counts verify against the stored content.
- **Capability honesty:** `/v1/capabilities/ledger` reports the consumer's
  collection state as observed only after receipts exist; catalog imports
  stay `declared` — domain/provider ownership proof is not claimed.

## Isolation verification — done

On `origin/main` `1e7427c` (post-#73 merge), real workerd D1/SQLite/R2 and
`node:sqlite` suites — 109 tests, all passing:

- `catalog-import-migration` — migration 0018 applies after every prior
  schema, replays without changing data, scope/identity triggers abort
  foreign and mutating writes.
- `accounts` — catalog imports commit atomically and idempotently, create
  no keys, reject bounded/invalid bodies; cross-account reads, key
  creation, revocation, imports, and report filters are denied on every
  route; archived projects leave account inventory.
- `capabilities` / `workspace-membership` — ledger auth and workspace
  scoping hold.
- `browser-archive` — restart, lost acknowledgement, corruption, missing
  and unreadable objects retain staging; segment manifests verify.
- `endpoint-durable`, `ingest` — retry-stable batch dedupe keeps accepted
  counts correct under duplicates and redelivery.

These suites prove migration replay, transactional rollback, and archive
recovery. They do not exercise a previous Worker version against the migrated
schema or prove Worker-version rollback; that compatibility check remains
required in isolation before production approval. **Also not proven:**
ownership beyond `declared` (domain verification is unimplemented by design),
and any production behavior. These remain explicit acceptance gaps.

## Production activation — approval-gated

Ordered; each step names its rollback. Stop on any failed check.

1. **Approve consumers + budgets** (this document).
2. **Apply migration 0018** to `app-health-control-plane`
   (`wrangler d1 migrations apply`). Additive; rollback = deploy previous
   Worker version, table remains inert, imports are not deleted.
3. **Deploy Worker** from an approved SHA at 100%, SHA-tagged. Rollback =
   promote the previous version ID.
4. **Catalog import**: authenticated `POST /v1/catalog/import` declaring
   `free-ai` and `saas-maker` with curated fields only. Verify
   `verification_state: "declared"`, idempotent retry returns the same
   App Health IDs, a conflicting retry returns a conflict.
5. **Free AI**: create the production environment key via
   `POST /v1/apps/:id/environments`; set `APP_HEALTH_INGEST_KEY` as a
   `free-ai-gateway` secret; deploy via Free AI's manual
   `cloudflare-deploy.yml`. Rollback = remove the secret and redeploy the
   previous Free AI version; revoke the key.
6. **Canary + fault tests** (below) for Free AI.
7. **SaaS Maker**: create a public key allowlisted to `sassmaker.com`, land
   the snippet + owner-authored log change in the SaaS Maker repository,
   deploy through its own approval path. Rollback = revert the consumer
   change, revoke the public key.
8. **Archive + cost window**: observe at least one hourly archival of real
   SaaS Maker data; verify segment manifests; take the 7-day cost snapshot.
   If no archive occurs in the window, report that as unverified rather
   than forcing one.

## Canary + fault/retry plan

- **Endpoint canary (Free AI):** known synthetic requests on a synthetic
  normalized route plus ambient traffic; resend one identical batch ID.
  Expect exact counts, no retry inflation, finite p50/p95.
- **Browser canary (SaaS Maker):** bounded known sessions/page views and
  one repeated batch; expect exact totals in the current report.
- **Faults:** duplicate ingest batch resend; queue redelivery; Worker
  redeploy mid-window; second-account and unauthenticated access attempts;
  hourly cron archival followed by manifest checksum verification.
- **Measurement:** before/after count queries on the owner APIs, freshness
  timestamps, and the cost snapshot above. Sanitized receipt only —
  app/environment IDs, versions, counts, percentiles, timestamps. Never
  key or owner-token values.

## Approval gates

Explicit owner approval is required before: migration 0018 on the
production D1, the Worker deploy, Free AI secret + deploy, the SaaS Maker
site change + deploy, and any deviation from the frozen budgets. Per the
PRD model split, tenancy, migration, durability, and release review of
this plan and its receipts route to the Astra review pass before step 2
runs.
