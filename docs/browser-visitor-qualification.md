# Operator qualification for exact browser visitor days

This procedure gathers evidence to qualify one CodeVetter production day for
an exact visitor count. It is manually invoked and reviewed by an authenticated
operator. Provider history, not elapsed time or an empty query, is the evidence
source.

## Current candidate

The candidate is **2026-10-01 Asia/Kolkata** for the CodeVetter production
app/environment. Its UTC interval is `[2026-09-30T18:30:00Z,
2026-10-01T18:30:00Z)`. The late-event and settlement window closes at
**2026-10-02T18:31:00Z (2026-10-03 00:01 Asia/Kolkata)**. Do not qualify it
before that instant.

Select this audited historical date explicitly with `?date=2026-10-01` in
both report reads below. At the cutoff (2026-10-03 00:01 Asia/Kolkata), the
default report date is the latest completed India day, **2026-10-02**. That
day has only just entered its own 24-hour late window and is not eligible for
qualification. Passing the Oct 1 cutoff does not make the default/latest day
exact; each day has its own cutoff and evidence review.

The currently recorded tracker activation is 2026-09-30 06:43:32 UTC. The
current App Health Worker rollout is version
`48944ec2-a5bc-49f2-9a3f-b00a20cce468`, source tag
`da7270d12e8b0f17bf69bcb3f4af5c20e7784d47`, activated at 2026-09-30
08:59:50.293 UTC and provider-verified at 100% in deployment
`16af810d-3f49-496f-9523-afe5c1197e7b`. Its rollout proof was recorded and
read back at `1790759466629` ([issue #92 receipt](https://github.com/sass-maker/app-health/issues/92#issuecomment-5908063899)).
Recheck provider history at qualification time; these values are the starting
evidence, not proof of continuity through the cutoff.

If a Worker rollout starts during this candidate interval, the current seal
query rejects the day even if the later version reaches 100%. A tracker source
change or deactivation also interrupts scope continuity. Leave the day
unsealed and the report `Unknown`; qualify a later full day from the newly
verified activation instead.

## Collect provider evidence

Run read-only commands from the App Health checkout with the existing Wrangler
login. They inspect provider state and do not deploy, consume Queue messages,
or change retention:

```sh
pnpm --filter @app-health/worker exec wrangler deployments list --name app-health-worker --json
pnpm --filter @app-health/worker exec wrangler deployments status
pnpm --filter @app-health/worker exec wrangler versions view <version-id>
pnpm --filter @app-health/worker exec wrangler pages deployment list --project-name codevetter --environment production --json
pnpm --filter @app-health/worker exec wrangler queues info app-health-browser-events
pnpm --filter @app-health/worker exec wrangler queues info app-health-browser-events-dlq
pnpm --filter @app-health/worker exec wrangler r2 bucket lifecycle list app-health-browser-history
```

`wrangler deployments list` returns only the ten most recent Worker
deployments. If that does not cover the complete interval from the recorded
rollout through the cutoff, use the Cloudflare deployment history/API export
for the full interval. For every Worker deployment record its provider start
time, version ID, source tag/SHA, and traffic transitions. Confirm the final
version and 100% traffic separately with `deployments status` and `versions
view`. An incomplete history, partial traffic, missing tag, or unexplained
rollback blocks the day.

For Pages, retain production deployment IDs, commit SHAs, and build times for
the full interval. Confirm that each deployed CodeVetter build keeps the
production app/environment scope and first-party tracker enabled. Make
anonymous reads of `https://codevetter.com/` and
`https://health.sassmaker.com/tracker.js` at the end of the interval; record
only status, observed time, deployment/source SHA, and tracker configuration.
Do not save visitor IDs, cookies, or request payloads.

`queues info` verifies topology and the configured consumer/DLQ relationship;
it does not prove queue drain. In Cloudflare Queues metrics, export the main
queue and DLQ backlog and message-operation series across the target day and
late window. Include backlog messages/bytes, oldest-message time, retries, and
delete outcomes (`success`, `dlq`, `fail`); also capture point-in-time backlog
at the end of the window. A zero backlog snapshot alone does not prove that
all day receipts were processed. Cloudflare documents the time-series and
point-in-time metrics in [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/).

The R2 lifecycle command is read-only. Confirm no age-based expiration can
remove relevant source segments during the visitor-ledger retention window.
The owner archive-audit job below verifies manifests and bytes for acquired
segments, but it cannot establish provider retention on its own.

Keep provider exports in the private operator record. Redact credentials and
message contents before hashing evidence; never put raw exports or secrets in
the repository or issue comments.

## Reconcile the accepted day before sealing

After the closure time, start the existing owner audit from the authenticated
App Health dashboard origin. This request has no workspace or product selector;
the owner session supplies the workspace:

```js
const started = await fetch('/v1/browser/archive-audits?day=2026-10-01', {
  method: 'POST',
  credentials: 'same-origin',
}).then((response) => response.json());
started;
```

Poll `GET /v1/browser/archive-audits/<job_id>` until the job is terminal. It
reads bounded D1 receipt pages, all 16 archive shard indexes, batch references,
and manifest-verified R2 bytes, then compares fact digests. It can report
matched, missing, legacy, duplicate, and digest-mismatch counts. A cap or
provider read error means the acquired comparison is incomplete.

**This audit always returns `complete: false`.** Its snapshot is not a global
Queue barrier and it cannot prove Queue/DLQ exhaustion or D1/R2 retention. The
current result includes `queue_evidence_unavailable`,
`dlq_evidence_unavailable`, `d1_retention_unverified`,
`r2_retention_unverified`, and `snapshot_is_not_current_state_barrier` by
design. Never relabel its counts complete. Pair its aggregate result with the
provider evidence above and keep the coverage blocked if any accepted batch is
unmatched or unverified.

For a privacy-safe D1 cross-check, query only aggregate counts in the Cloudflare
D1 console. Substitute the verified workspace, app, and production environment
IDs and a current `now_ms`; never select `visitor_hash` or batch IDs:

```sql
SELECT
  (SELECT COUNT(*) FROM browser_visitor_days
   WHERE workspace_id = '<workspace_id>' AND app_id = '<app_id>'
     AND environment_id = '<production_environment_id>'
     AND india_day = '2026-10-01' AND expires_at > <now_ms>) AS d1_visitors,
  (SELECT COUNT(*) FROM browser_visitor_receipt_days day_receipt
   JOIN browser_visitor_batch_receipts receipt
     USING (workspace_id, app_id, environment_id, batch_id)
   WHERE day_receipt.workspace_id = '<workspace_id>'
     AND day_receipt.app_id = '<app_id>'
     AND day_receipt.environment_id = '<production_environment_id>'
     AND day_receipt.india_day = '2026-10-01'
     AND receipt.expires_at > <now_ms>) AS accepted_batches,
  (SELECT COUNT(*) FROM browser_visitor_receipt_days day_receipt
   JOIN browser_visitor_batch_receipts receipt
     USING (workspace_id, app_id, environment_id, batch_id)
   JOIN browser_queue_stage_receipts staged
     USING (workspace_id, app_id, environment_id, batch_id)
   WHERE day_receipt.workspace_id = '<workspace_id>'
     AND day_receipt.app_id = '<app_id>'
     AND day_receipt.environment_id = '<production_environment_id>'
     AND day_receipt.india_day = '2026-10-01'
     AND receipt.expires_at > <now_ms> AND staged.expires_at > <now_ms>) AS staged_batches;
```

Compare aggregate counts only. A missing staging receipt is unresolved; it is
not proof that a message failed. A staging receipt proves durable DO staging,
not successful R2 archival. R2 parity must come from the archive audit's
verified comparisons plus reviewed Queue/DLQ evidence.

## Verify the report inputs before sealing

The deployed `/v1/reports/daily-engagement` route reads exact D1 visitor rows
and prefers them for scopes whose day is complete and sealed; otherwise it
uses Analytics Engine or reports `Unknown`. The authenticated Daily page reads
this route directly. Therefore a successful seal can change the next report
response without a separate consumer deployment. The report tests cover
complete exact counts and exact zeroes, while incomplete and unactivated scopes
remain `Unknown` (`apps/worker/test/daily-engagement-report.test.ts`).

Complete the external acceptance review before sealing because the seal is
immediately visible to this report path. Capture the report with the audited
historical date explicitly while the fence is open; this records Analytics
Engine's current CodeVetter count and sampling reason without returning
visitor identifiers:

```js
const report = await fetch(
  '/v1/reports/daily-engagement?date=2026-10-01&browser_visitor_unknown_reason=1',
  { credentials: 'same-origin' },
).then((response) => response.json());
report.products.filter((row) => row.catalog_id === 'codevetter');
```

Compare CodeVetter's aggregate D1 visitor count with AE when its group is
numeric and unsampled; investigate any mismatch. A sampled CodeVetter group
cannot supply an exact parity control. Do not scale it or require it to equal
the exact count. Instead, use reviewed unsampled product/day control groups
and their archived facts for the issue's representative AE/archive parity
check, and compare CodeVetter's accepted receipts against its verified archive
facts using the bounded audit above. Record the selected controls and
aggregate results. If no valid unsampled control or archive comparison is
available, keep the day unsealed and the report's CodeVetter value `Unknown`;
do not expose an exact D1 fallback before the issue's acceptance gates pass.
The report uses the configured Analytics Engine query internally; no token
should be copied into a shell or browser command.
Cloudflare describes `_sample_interval` and the SQL API in the [Analytics
Engine SQL API documentation](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).

## Record proof and seal once

The authenticated `POST /v1/browser/visitor-coverage` endpoint accepts these
actions: `rollout-start`, `rollout-full`, `tracker-activate`,
`tracker-deactivate`, `audit`, and `seal-day`. Use same-origin `fetch` from the
authenticated dashboard, recording the actual provider values from the
reviewed evidence. It derives workspace identity from the owner session.

The exact inputs are:

- `rollout-start`: unique `generation_id`, `worker_version_id`, 40-hex
  `source_sha`, provider `rollout_started_at`, later `rollout_observed_at`, and
  observed `rollout_traffic_percent`.
- `rollout-full`: the same generation/version/SHA, provider-observed
  `full_traffic_at`, later `observed_at`, and exactly `traffic_percent: 100`.
- `tracker-activate`: app/environment IDs, verified activation time, later
  verification time, and the 40-hex Pages/source SHA. Record deactivation if
  the tracker is disabled or removed.
- `audit`: unique `audit_id`; `audit_kind: 'worker_rollouts'` with no scope
  fields, or `audit_kind: 'tracker_scope'` with app/environment IDs;
  `audited_through` at least the cutoff, `observed_at` after the cutoff, and
  `evidence_sha` (SHA-256 of the redacted evidence for that specific audit).
- `seal-day`: the app ID, production environment ID, and `day: '2026-10-01'`.

The proof writes are not retry-idempotent. If a request times out or returns a
conflict, read the exact row from D1 before attempting another write. Do not
blindly replay a proof action.

**The seal endpoint checks only its D1 rollout/scope rows, their audits, the
late-event cutoff, and overlapping intervals. It does not check Queue/DLQ,
R2 retention/parity, or Analytics Engine parity.** Those external acceptance
gates have no typed fields in the proof endpoint, so retain their reviewed
evidence in the operator record and satisfy them before submitting `seal-day`;
the report can consume a newly sealed exact value immediately. The endpoint
returns 409 when its own checks fail; that response is a stop condition, not a
reason to edit or fabricate evidence.

After a successful seal, fetch `/v1/reports/daily-engagement` again with the
same explicit `?date=2026-10-01`. Verify CodeVetter's row uses the exact count
and matches the previously reviewed aggregate D1 count. The Daily page reads
this same report route. An empty unsealed day remains `Unknown`; missing,
sampled, or unqualified data must never become an automatic zero.

## Remaining automation gap

There is no sound unattended collector today. Wrangler deployment history is
bounded to ten recent Worker deployments; current Queue backlog is a point-in-
time view; the archive audit is deliberately incomplete; and the owner proof
endpoint cannot receive Queue, R2-retention, or AE-parity evidence. The future
operator tool must obtain complete provider history, retain a reviewed
redacted evidence artifact and require reviewed gate evidence before
submitting audit or seal actions. Until
those provider APIs and durable evidence fields exist, the safe workflow is
this manual runbook; missing evidence keeps the report `Unknown`. This
describes an authenticated operator workflow, not a new approval step.
