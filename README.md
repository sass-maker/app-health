# app-health

App Health brings endpoint health, intentional logs, and product analytics into
one workspace. Sign in with Google, create a project and its environments, and
connect only the capabilities you need. Each capability shows setup until traffic
arrives. Fleet's internal Site Health dashboard is a separate product.

- **API health:** batched route measurements from Cloudflare Workers, Hono, Pages,
  Node, Go, or OTLP.
- **Logs:** explicit level-based events with bounded ingestion and 30-day retention.
- **Analytics:** a small browser tracker, optional JavaScript modules, a Foundation
  Swift SDK, recent active sessions, and revocable aggregate-only public links.

The dashboard uses shadcn components with light and dark themes. Cloudflare D1,
Analytics Engine, Queues, Durable Objects, and compressed R2 archives provide the
production backend. SDKs keep independent entry points to avoid loading unused
capabilities. See [integration readiness](docs/integration-readiness.md),
[Google accounts](docs/accounts.md), and [efficiency](docs/efficiency.md) for exact
verification status and limits. Source support does not imply every SDK module is
already published to a package registry.

## Repository layout

```
apps/
  web/      Vite + React setup flow and observed-endpoint dashboard
  worker/   Cloudflare Worker + D1/Analytics Engine production adapters
packages/
  contracts/  V1 event, aggregate, app/key, installation-status, query
              contracts with zod runtime validation and canonical fixtures
  node/       @saas-maker/app-health client plus Express, Hono, and Pages adapters
  go/         Go 1.22 client with net/http and Echo adapters
  swift/      Foundation client for explicit native events and logs
openspec/specs/   Canonical behavior specifications
openspec/changes/archive/   Completed and superseded change history
```

## Runtime dependencies (and why)

V0 keeps the dependency surface small because both SDKs eventually run inside
customer request paths.

| Dependency                                                                                                | Where                                                | Why                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `zod`                                                                                                     | packages/contracts                                   | Runtime validation of v1 ingest/query payloads. Single, well-vetted library; reused by worker and node SDK.  |
| `react`, `react-dom`                                                                                      | apps/web                                             | Operator dashboard shell. Required by the Vite + React stack.                                                |
| `vite`, `@vitejs/plugin-react`                                                                            | apps/web (dev)                                       | Local dev server and production build of the operator shell.                                                 |
| `vitest`, `jsdom`, `@testing-library/react`                                                               | apps/web (dev)                                       | Component tests for the dashboard shell.                                                                     |
| `vitest`                                                                                                  | packages/contracts, packages/node, apps/worker (dev) | Contract and worker unit tests.                                                                              |
| `@cloudflare/workers-types`                                                                               | apps/worker (dev)                                    | Type definitions for the Worker `fetch` handler. No runtime dependency.                                      |
| `@bufbuild/protobuf`                                                                                      | apps/worker                                          | Bounded protobuf wire reader/writer used to project OTLP traces without adding an OpenTelemetry SDK runtime. |
| `typescript`, `eslint`, `prettier`, `typescript-eslint`, `@eslint/js`, `eslint-config-prettier`, `rimraf` | root (dev)                                           | Shared typecheck, lint, format, and clean tooling.                                                           |
| `knip`, `jscpd`, `@vitest/coverage-v8`                                                                    | root (dev)                                           | Unused-code, duplication, and test-coverage evidence for the Fleet code-health gate.                         |
| `tsup`                                                                                                    | packages/node (dev)                                  | Produces the public SDK's ESM, CommonJS, and declaration artifacts.                                          |
| Go standard library                                                                                       | packages/go core                                     | Bounded queue, delivery, diagnostics, and `net/http` middleware.                                             |
| `github.com/labstack/echo/v4`                                                                             | packages/go/echo                                     | Framework route-template and response/error integration; v4.12 is the Go 1.22-compatible minimum.            |

`APP_HEALTH_MODE=local` uses the in-memory adapter. Production mode requires a
bound D1 database, Analytics Engine dataset, read-scoped query-token secret,
owner-authentication secret, and the approved hostnames before it will serve
owner data. The production dashboard keeps the entered owner key in page memory
only and requires it again after refresh.

## Local commands

All commands run from the repository root unless noted.

### Install

```bash
pnpm install
```

### Repository checks

```bash
pnpm run check            # complete TypeScript + Go code-health gate
pnpm run format           # write prettier formatting
pnpm run format:check     # verify prettier formatting
pnpm run lint             # eslint
pnpm run typecheck        # tsc --noEmit across all workspace packages
pnpm run test             # vitest run across all workspace packages
pnpm run build            # build all workspace packages (web -> vite build)
pnpm run quality:coverage # ratcheted Vitest + Go coverage
pnpm run quality:unused   # strict Knip unused-code/dependency analysis
```

### Go (packages/go)

```bash
cd packages/go
go test ./...
go vet ./...
```

## Install the SDKs

Public package verification and remaining release work are tracked in
[SDK installation and release parity #57](https://github.com/sass-maker/app-health/issues/57).
SDK 0.4.0 includes core, Express, Hono, Pages and the browser logger.
Endpoint telemetry and explicitly authored browser logs retain separate privacy
boundaries; browser logs require an origin-allowlisted public log key.

### Express on Node.js 20+

The SDK is distributed through the public GitHub release below. The npm
registry package is not currently available.

```bash
npm install https://github.com/sass-maker/app-health/releases/download/node-v0.4.0/saas-maker-app-health-0.4.0.tgz
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

// During graceful shutdown:
await appHealth.close();
```

### Hono and Cloudflare Pages Functions

The public `node-v0.4.0` GitHub Release is the install fallback while the npm
publisher identity remains unavailable:

```bash
npm install https://github.com/sass-maker/app-health/releases/download/node-v0.4.0/saas-maker-app-health-0.4.0.tgz
```

For Hono Workers, configure the core client with `runtime: 'worker'` and
`disableTimer: true`, then mount `honoMiddleware` from
`@saas-maker/app-health/hono`. For a Pages Function, wrap the handler with
`withPagesFunctionHealth` from `@saas-maker/app-health/pages` and pass the
file route as a trusted template. Both adapters use `waitUntil`, preserve the
application response, and become a no-op when a lazy client resolver returns
`null`.

### Echo on Go 1.22+

```bash
go get github.com/sarthakagrawal927/app-health/packages/go/echo/v5@v5.1.0
```

The repository now lives under SaaS Maker. The original GitHub namespace
remains the Go module path so existing imports and published module versions
continue to work.

```go
cleanup := apphealthechov5.Install(e, apphealthechov5.Config{
	Enabled:     true,
	Environment: "staging",
	Key:         os.Getenv("APP_HEALTH_INGEST_KEY"),
	Project:     "orders-api",
})
defer cleanup()
```

The Echo installer owns the production ingest endpoint, batching, retries,
privacy filtering, and bounded shutdown. Set `Enabled` from application policy;
an empty key or disabled config is a no-op. Use `appHealth.diagnostics()` for
Node delivery counters.
Complete runnable examples live in `examples/go-echo` and `examples/node`.
The Echo example intentionally consumes a tagged module without a
local `replace`, so it also acts as a release-distribution canary.

## Connect an existing OpenTelemetry pipeline

Services that already send traces through an OpenTelemetry Collector do not
need an App Health SDK. Add the standard OTLP/HTTP exporter below alongside the
exporters already present in the traces pipeline:

```yaml
processors:
  resource/app_health:
    attributes:
      - key: deployment.environment.name
        value: ${env:APP_ENV}
        action: upsert

exporters:
  otlphttp/app_health:
    traces_endpoint: https://ingest.sassmaker.com/v1/traces
    headers:
      Authorization: Bearer ${env:APP_HEALTH_INGEST_KEY}

service:
  pipelines:
    traces:
      # Keep the pipeline's existing receivers, processors, and exporters.
      processors: [your_existing_processors, resource/app_health]
      exporters: [your_existing_exporter, otlphttp/app_health]
```

The endpoint accepts OTLP/HTTP protobuf or JSON and bounded gzip compression.
It projects only server spans that contain a trusted `http.route`, using the
current HTTP semantic attributes (`http.request.method` and
`http.response.status_code`) or their legacy aliases (`http.method` and
`http.status_code`). `service.version` is used as the optional release.

App Health discards the trace and every unrelated attribute after projecting
method, normalized route, status, duration, timestamp, and optional release. It
does not retain trace/span IDs, URLs, query strings, headers, identities,
events, links, logs, bodies, or stack data. Trace pipelines may sample before
export, so the dashboard labels all OTel-derived request counts, error rates,
and latency figures as sampled estimates rather than complete traffic totals.

Run the focused local ingestion checks with:

```bash
pnpm --filter @app-health/worker exec vitest run test/otlp.test.ts
```

## SDK release procedure

SDK releases are explicit rather than automatic:

```bash
pnpm --filter @saas-maker/app-health run pack:verify
npm whoami
npm publish packages/node --access public

# If npm authentication is unavailable, publish the verified tarball as the
# node-v0.4.0 GitHub Release asset instead.

GO_CORE_VERSION=0.1.5
git tag "packages/go/v${GO_CORE_VERSION}"
git push origin "packages/go/v${GO_CORE_VERSION}"

# When the separate Echo v5 module changes:
ECHO_V5_VERSION=5.1.1
git tag "packages/go/echo/v${ECHO_V5_VERSION}"
git push origin "packages/go/echo/v${ECHO_V5_VERSION}"
```

Only publish or tag the exact pushed commit after repository and consumer
checks pass. npm publication is skipped when publisher authentication is not
available.

### Web dev server

```bash
pnpm --filter @app-health/web dev
```

Vite serves the credential-free, in-memory Worker API on the same local origin,
so setup, ingest, installation checks, and endpoint queries work without a
deployment. Set `VITE_APP_HEALTH_API` only when pointing the UI at another V1
API implementation.

For a populated local view, open `/?demo=populated`. This development-only
route uses explicitly labelled seeded fixtures and never exposes its key. These
metrics do not demonstrate an SDK connection.

To verify actual synthetic traffic through the local SDK and Worker, run:

```bash
pnpm run verify:local-sdk
```

This builds the Node SDK, starts temporary loopback-only Vite and Express servers,
creates a fresh in-memory project, and sends successful and failing parameterized
requests through the Express middleware. It checks the same installation and
endpoint aggregate APIs used by the dashboard: waiting before traffic, connected
after ingest, normalized route, exact counts and error rate, and latency values.
Both servers stop afterward. No credentials or production services are used.

This local receipt does not qualify Cloudflare persistence, a deployed dashboard,
or an external user's onboarding. Fresh owned-service production traffic and
aggregate visibility remain required under [#55](https://github.com/sass-maker/app-health/issues/55).

## UI evidence

Current browser captures are checked in under `docs/screenshots`:

| State               | Desktop                                             | Mobile                                             |
| ------------------- | --------------------------------------------------- | -------------------------------------------------- |
| Setup               | [setup](docs/screenshots/setup-desktop.png)         | [setup](docs/screenshots/setup-mobile.png)         |
| Waiting for traffic | [waiting](docs/screenshots/waiting-desktop.png)     | [waiting](docs/screenshots/waiting-mobile.png)     |
| Populated endpoints | [populated](docs/screenshots/populated-desktop.png) | [populated](docs/screenshots/populated-mobile.png) |

## V1 contract surface

`packages/contracts` exposes:

- `EventV1`, `EventBatchV1`, `validateBatch` — ingest payload and runtime
  validation with field bounds (event_id UUID v4, method uppercase A-Z,
  route starts with `/` and ≤ 256 chars, status 100-599, duration 0-600000ms,
  batch ≤ 1000 events, schema_version `v1`).
- `EndpointAggregateV1`, `EndpointQueryRequestV1`, `EndpointQueryResponseV1`,
  `BucketV1` — query response, query request, and one-minute aggregate bucket.
- `AppV1`, `EnvironmentV1`, `KeyRecordV1`, `KeyDisplayV1`,
  `CreateAppRequestV1`, `CreateAppResponseV1` — app/key setup.
- `InstallationStatusV1` — installation verification.
- `healthState` — deterministic health calculation.
- `nodeBatchFixture`, `goBatchFixture`, `areEndpointEquivalent` — canonical
  Node and Go fixtures with equivalent endpoint summaries.
- `SEED_BUCKETS`, `seededAggregateResponse`, `mergeBuckets`,
  `approximatePercentiles` — seeded endpoint metrics for the in-memory dev
  adapter.

`packages/go` mirrors the same types, bounds, validators, and fixtures in Go.
Its core and `net/http` middleware use only the standard library; the `/echo`
subpackage adds Echo v4 integration.

## Observed-endpoint semantics

The dashboard lists **observed** endpoints only. An endpoint appears once it
has received at least one instrumented request. Source-code route inventory is
not shown because uncalled routes cannot be inferred consistently across Node
and Go runtimes.

### Health states (deterministic, not configurable)

- `insufficient-data` — fewer than 20 requests in the selected window.
- `unhealthy` — error rate ≥ 5% or p95 ≥ 2000 ms.
- `degraded` — error rate ≥ 1% or p95 ≥ 1000 ms.
- `healthy` — below both degraded thresholds.

Percentiles are approximate in production because Analytics Engine may sample
high-volume indexes. Queries weight every count by `_sample_interval`, then
derive percentiles from merged fixed latency-histogram counts, never by
averaging bucket percentiles. Bucket bounds are listed in
`packages/contracts/src/constants.ts` and mirrored in
`packages/go/contracts.go`. A normalized D1 inventory ensures rare endpoint
identities remain visible even when Analytics Engine omits a sampled metric row;
the dashboard shows those metric values as unavailable, never as false zeros.

## Application logs

Endpoint telemetry tells you how routes perform. Logs tell you what happened:
a signup, a waitlist join, a failed payment. They are explicit, owner-authored
events an application chooses to send, never derived from traffic.

- `POST /v1/logs` on the ingest host accepts a `LogBatchV1` with the same
  product ingest key as `/v1/ingest`. Each log has a lowercase `event` name, a
  `level` (`debug`, `info`, `warn`, `error`), optional `title`, `description`,
  `icon`, and up to 40 scalar `props`.
- The dashboard's **Logs** tab lists them newest first, filterable by minimum
  level and event name. `GET /v1/logs` serves the same query to the owner.
- Rows live in D1 for 30 days and are pruned hourly.
- Optional Slack alerts: set the `LOG_ALERT_WEBHOOK_URL` secret and the
  `LOG_ALERT_MIN_LEVEL` var (default `info`) and every log at or above that
  level is posted after the ingest response returns.
- Node: `appHealth.log('signup', { title: user.email, props: { plan } })`.
  Any runtime: copy `examples/dropin-log-client/ping.ts`, which posts one
  batch per call with no dependencies. The Go SDK does not send logs yet.
- Browser: create a public key (`ahk_pub_…`) in the Logs tab, pinned to your
  origins and rate limited, then `createWebLogger` from
  `@saas-maker/app-health/web` (or copy `ping-web.ts`). Browser logs are
  stored as `source: browser` and alert only at `error` by default.
- Routing: `LOG_ROUTES` decides per log which sinks (`store`, `slack`) receive
  it, matched on source, level, and event.

See [docs/logs.md](docs/logs.md) for the wiring guide and decision record.

## Privacy boundary

Endpoint telemetry stores **only** method, normalized route, status code,
duration, timestamp, and optional release. It MUST NOT store headers, cookies,
query values, route parameter values, request or response bodies, user
identity, stack traces, or spans, and it never infers logs from requests.
Application logs are the one deliberate exception: they carry exactly what the
owner's code passes to `log()`, are sent only when that code calls it, and are
kept for a bounded 30 days. Nothing in a log is ever derived from a request. The OTLP endpoint projects this allowlist from eligible
server spans and discards the rest; contract validators reject unknown fields,
and both SDKs enforce the same boundary at capture time. Official adapters drop
an event when no trusted framework route template exists rather than sending a
concrete request path. Optional release strings use a bounded machine-safe
character set; unsafe free-form values are omitted.

## Production boundary

- `health.sassmaker.com` is the private owner-key-protected dashboard and owner API.
- `ingest.sassmaker.com/v1/ingest` and `/v1/traces` accept only
  product-scoped bearer keys with an explicit client environment.
- D1 stores control-plane records, bounded event-ID deduplication, the
  normalized endpoint identity plus first/last seen, and owner-authored
  application logs for 30 days; Analytics Engine stores approved aggregate
  endpoint dimensions and counts.
- Direct `workers.dev` access is disabled. Missing bindings, owner or query
  credentials, or hostname settings fail closed.
- The release uses the account's existing Workers subscription. It does not
  activate Zero Trust or another Cloudflare subscription.

## Current boundary

The endpoint-only V0 is live on Cloudflare with both approved hostnames, D1,
Analytics Engine, and owner/ingest key boundaries. Real Node and Go canaries
proved creation, key handoff, ingest, connected state, and normalized endpoint
inventory. Owner-authored application logs with optional Slack alerts shipped
alongside. Stored trace exploration and broader incident workflows remain
explicitly out of scope.

<!-- portfolio-retained-work:2026-09-07 -->

## Retained work from the portfolio review

These are unresolved requirements retained at the owner’s request. They are not completed features. Work should follow a concrete need and fresh evidence.

### Integrate across fleet

Qualify actual SDK ingest and aggregate visibility in each adopted service; source imports or fixture dashboards do not prove production integration.

Original requirements and discussion: [#55](https://github.com/sass-maker/app-health/issues/55).
