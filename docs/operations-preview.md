# Operations source review

The workspace Operations view (`/app#operations`) groups observations from real
collector inputs. It is an owner-local review surface. Production ingestion,
webhooks, background collection and automatic repairs are not activated by it.

The model keeps source families, individual feeds and observations separate.
For each feed it retains the producer, collector, original collection time,
source observation time, collection freshness and monitored condition. An old
failed workflow can remain a current finding after a fresh provider read.
Missing data and inaccessible APIs never imply a healthy product or zero use.

## Collect

Use Node 24 or later. Inputs are optional except the canonical catalog and output.
Keep the private output outside source checkouts and public assets.

```sh
node scripts/collect-operations.mjs \
  --catalog /private/catalog.json \
  --github /private/github-actions.json \
  --deployments /private/deployment-inventory.json \
  --workspace-state /private/workspace-status.json \
  --probe-results /private/http-probes.json \
  --security /private/github-security.json \
  --site-health http://127.0.0.1:4187 \
  --output /private/operations-snapshot.json
```

GitHub input is the existing Actions health collector's paginated result.
Deployments use `{generatedAt, targets: [...]}` with project, target, kind,
deployed/currentMain revisions and currentParity. Original collection times
must be supplied; importing a file does not renew its source freshness.

Probes use `{generatedAt, results: [{id, projectId, name, url, observedAt,
status, httpStatus, durationMs, detail}]}`. Status is healthy, failing or unknown.
The HTTP adapter qualifies availability only, not core product journeys.

Security uses `{generatedAt, repositories: [{repository, observedAt, dependabot,
codeScanning}]}`. Each API has status available/unavailable and alerts containing
id, title, severity and url. Access failures remain visible coverage gaps.

The collector reads only Site Health's loopback evidence-status and readiness
APIs. It never reads credentials or changes providers. A failed optional input
becomes an unavailable source; the other sources remain reviewable.

## Review locally

Set `APP_HEALTH_OPERATIONS_FILE` for the development process to the private
snapshot, then run the web development server bound to `127.0.0.1`. Open
`/app#operations`. The dev API refuses foreign origins, remote peers and shared
workspace headers. It does not expose local input paths or arbitrary properties.

Reload snapshot re-reads the file. It does not start a provider collection.
The dashboard recomputes freshness as time passes. It groups access gaps and
informational source/revision findings separately from the attention inbox.

Focused checks are `node --test scripts/operations-normalize.test.mjs` and the
web OperationsView/operations-preview tests. Normalizers are credential-free.
