# Product analytics platform decision

Tracking: https://github.com/sass-maker/app-health/issues/58 (task 1)

## Decision

App Health grows into an account-backed product analytics application on the
existing Cloudflare data plane:

- **D1 control plane** — accounts, workspaces, membership, projects,
  environments, declared sources, keys, capability receipts, goals, and
  annotations. Mutable, transactional, small.
- **Workers Analytics Engine** — hot aggregate analytics and endpoint
  telemetry, as today.
- **Pipelines → R2** (planned, task 12) — exact retained event history with
  immutable schema versions, replay, and explicit retention. Not yet built;
  nothing below assumes it exists.
- **Better Auth + D1** — Google sign-in and sessions, as shipped in the first
  account slice (`docs/accounts.md`).

This extends the current plane rather than adding a new store: the durability
and cost properties are already proven by the endpoint pipeline, and every new
surface inherits the existing retention and fail-closed rules.

## Hosted/local boundary

| Runs hosted                                                        | Stays local / out of scope                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Collector, dashboard, D1 control plane, AE aggregates, share links | Raw-request replay, long exact history (until Pipelines lands)         |
| Canonical envelope validation at ingest                            | Session recordings, screenshots, visitor identity beyond opaque hashes |
| Per-project/environment scoped credentials                         | Any private server key inside a distributed client                     |

Local development reproduces every hosted surface through Miniflare D1, the
worker, and the seeded store; no acceptance claim depends on production-only
behavior without a separately recorded production check.

## Canonical event envelope

`packages/contracts/src/product-event.ts` defines
`app-health.product-event.v1` — one versioned shape for browser, server, and
manual events (`page_view`, `event`, `identify`, `revenue`).

Invariants:

- Scope (project/environment) is stamped from the credential at ingest, never
  trusted from the payload.
- Flat bounded `properties` only (20 keys, scalars only, no nesting) — the
  envelope cannot carry request bodies, credentials, or free text.
- `visitor_id`/`session_id` are opaque bounded strings; account identity is
  resolved server-side and never written into telemetry.
- Type refinement is structural: `page_view` requires `path` and forbids
  `name`; `event`/`identify` require `name`; `revenue` requires a bounded
  integer-cent amount with an ISO 4217 currency and cannot appear elsewhere.
- The strict schema rejects unknown fields, so envelope drift is a parse
  error, not silent data loss.

The existing channel contracts (`EventV1` endpoint telemetry,
`BrowserEventV1` page views, native/log events) remain authoritative for
their transports; collectors map onto this envelope at the storage boundary
so projections never branch on transport.

## Remaining work

Tasks 4–14 in the tracking issue build on this foundation: onboarding flows
(task 4), Fleet catalog importer (5), capability ledger (6), collector Worker
(9), SDKs (10), evidence sources (11), exact history (12), D1 product facts
(13), and the portfolio views (14). Production activation, real Google
callback verification, and deploys remain owner-side.
