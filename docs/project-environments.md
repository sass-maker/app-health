# Projects, environments, and capabilities

App Health has one workspace of projects. Each project can have up to 20 environments.
Web analytics (including named product events), Endpoint health, and Logs are independently
adopted within each environment. Project settings store navigation preferences; disabling a
capability does not revoke keys or discard incoming data.

## Credentials

New projects created in the dashboard request `key_scope: "environment"`. Their private
server key accepts endpoint telemetry and explicit server logs only for that environment.
It cannot authenticate dashboard reads or administrative APIs. Public browser keys are
issued after the owner provides allowed origins; they accept browser analytics and explicit
browser logs for the same environment. Private and public keys are independent credentials,
not an asymmetric cryptographic key pair. Only verifier hashes are stored. Raw keys appear once.

Existing API clients omitting `key_scope` retain their legacy product-wide key behavior.
Legacy product keys retain their pre-existing restricted read behavior; new environment keys
never inherit it. Account sessions and the existing owner credential manage the new project APIs.
Private-key replacement atomically revokes the environment's previous private keys and creates
one replacement. It does not revoke another environment's keys, browser keys, or legacy
product-wide keys. Existing apps with legacy keys should retire those separately when migrating.

## State

Each capability stores an enabled preference and first/last accepted receipt times, keyed by
project and environment. First valid events activate it automatically. A browser heartbeat,
invalid batch, rejected origin, or unavailable downstream collector does not establish receipt.

Before first receipt the capability shows installation. Once received, it shows its report,
including an empty-window state when there is no recent data. Receipt metadata outlives log
retention and analytics windows. Query or configuration failures remain errors, never invented
setup or successful collection states. Selecting an environment also scopes browser reports.

## API

- `GET /v1/capabilities?app_id=…&environment_id=…` returns capability state and private-key metadata.
- `PUT` at that URL with `{ "enabled": ["analytics", "endpoints", "logs"] }` saves choices.
- `POST /v1/apps/:appId/environments` with `{ "name": "staging" }` creates an environment and
  its one-time private key. Concurrent duplicate names produce one success and one conflict.
- `POST /v1/apps/:appId/environments/:environmentId/keys` replaces that environment's private key.
- The existing `/v1/public-keys` API creates origin-bound public browser keys.

All new APIs verify ownership and the environment's parent project. Capability and setup request
bodies are bounded to 4 KiB. D1 batches make environment/key creation and key replacement atomic.
See [Cloudflare's batch contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Activation and next slices

Migration `0008_environment_capabilities.sql` is additive and prepared for explicit activation.
It backfills endpoint receipt from installation status and log receipt from retained logs.
No production migration, resource creation, or deployment is part of this work.

Preserve the existing API-monitoring pipeline. The logging infrastructure already includes D1
retention, server/browser SDK clients, routing, and optional Slack delivery; see [logs](logs.md).
For the next web-analytics slice, review selective reuse from the
[MIT-licensed Traks repository](https://github.com/shivamanupadi/traks): its tracker, period/query
helpers, and hot/history query design are candidates, not integrated code or proven replacements.
Keep App Health's ownership, environment scopes, and design system as the integration contract.
Implementation and verification tracking remains in [issue 58](https://github.com/sass-maker/app-health/issues/58).

## Primary integration targets

Cloudflare Workers and the websites they serve are the primary web/server targets; Swift is the
planned native target. Platform and environment are separate: a Cloudflare or Swift application
can send to production, staging, or development within its project.

Use runtime-specific entry points with optional capabilities and shared event conventions.
Keep the default website tracker small. A logs-only integration should not install page-view
listeners, and analytics-only use should not install request middleware. Verify the actual bundle
and background activity for each import before claiming size or overhead improvements. The
existing JavaScript SDK has separate web, Hono, and Pages entry points; this foundation adds no
SDK dependency. Native Swift instrumentation remains to be built. Prioritize working integrations
in Fleet's Cloudflare and Swift projects, including real-event verification. App Store Connect
belongs elsewhere and is outside this project's scope.

## Local verification, 2026-09-12

`mise exec node@24.20.0 -- pnpm run check` passes, including all 100 browser tests.

Environment/receipt tests exercise authorization, rejected events, concurrent receipts, quiet
history, scoped key rotation, and first-request local initialization. Account tests use real local
D1 for atomic creation, duplicate races, ownership, and migration backfill. The workerd canary
verifies account/session routing and browser queue/archive/presence delivery; a real Google
callback still requires provider configuration.

Browser coverage includes actual tracker, logs, and endpoint setup-to-report transitions,
environment isolation, mobile switching, key revelation/revocation, and populated/empty/error
layouts in both themes. Independent foundation review scored 34/40 for usability and 16/20 for
the UI audit, with no remaining P0/P1. Evidence is under
`.fleet/evidence/app-health-redesign/foundation-review-a/` and `foundation-review-b/`.
Remaining design follow-up is compact mobile settings and tablet sidebar density. The UI audit
does not establish production performance or complete assistive-technology conformance.

The local SDK benchmark now retains one listener per timing run, preventing ephemeral listener
and pooled-socket races while preserving the existing overhead threshold. Its synthetic timing
is a regression check, not a production SDK performance claim.
