# App Health

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Product managers, founders, and product teams who want to understand traffic,
intentional user actions, and the health of their projects in one place. The
owner is the initial user. Developers connect instrumentation; the dashboard
must be useful without backend engineering knowledge.

## Product Purpose

App Health is a Fleet product. It brings backend health, explicitly authored
events, general analytics, and online viewers together with easy integration.
Site Health is Fleet's private internal portfolio dashboard; it consumes
information from App Health and other sources. These are separate products.

## Operating Context

The owner confirmed this boundary and asked to proceed on 2026-09-12. The account
workflow is Google sign-in, a personal workspace, and adding projects. Preserve
the existing App Health implementation; Traks is reference material only.

## Capabilities and Constraints

Existing code provides endpoint traffic, latency, errors, Node/Go middleware,
OTLP intake, explicit server/browser logs, and revocable project keys. Endpoint
telemetry never captures request bodies, headers, cookies, or identities.

Google accounts and workspace-owned project onboarding are implemented locally
in the current account slice. Production activation and real Google callback
verification are separate. Do not advertise them as live before that verification.
General browser analytics and portfolio live viewers came through issue #58.
The owner's 2026-10-25 request uses DataBull, Traks and Minilytics as references
for the core analytics and revenue delivery in
[#219](https://github.com/sass-maker/app-health/issues/219). The owner subsequently
narrowed that request to required features; full reference parity is not the goal.

The dashboard leads with web analytics and a dedicated Events view. Application
health, logs, and collection details support investigation. The public landing
page has a footer; the dashboard does not. Dark mode is the default, with a
persistent light-mode option. See the [redesign plan](docs/product-analytics-redesign.md).

## Product Principles

- Keep integration small and failure isolated from the instrumented application.
- Enforce ownership on the server, independently of browser project selection.
- Label sampled data, fixtures, and unavailable capabilities honestly.
- Prefer evidenced Cloudflare-native primitives; keep account state separate
  from analytics ingestion and never write raw clickstreams to D1.

## Evidence on Hand

Repository tests, local synthetic SDK verification, and account tests using real
D1 SQL and Better Auth session handling. No production Google credentials or
customer traffic were used to prove this account slice.

The first browser analytics slice provides a small public-key tracker, named manual events, workspace-wide 24-hour counts, and active browser sessions. See [browser analytics](docs/browser-analytics.md) for delivery semantics, verification, and production activation gates. Broader DataFast parity remains tracked in issue 58.

## Integration model

Projects contain environments and independently adopted capabilities. Each environment owns
public client-ingestion credentials and private server-ingestion credentials. Setup remains
visible until valid data arrives for that capability; quiet connected reports retain their
receipt history. See [project environments](docs/project-environments.md).

Prefer one SDK per runtime with optional capabilities rather than one installation per capability.
A website can use one script tag or browser entry point; a Cloudflare Worker uses a server
entry point; future Apple-native support uses a Swift package. Cloudflare applications and
Swift applications are the primary platform targets. Preserve existing Node and Go integrations.
Keep optional instrumentation out of the base client: disabled features should add no hooks,
timers, or network requests, and verify bundled size for each supported import before making
size claims. Shared concepts are explicit named events,
structured logs, and optional automatic instrumentation appropriate to that runtime. Browser and
native distributed clients must never contain private server credentials. Swift support remains
a future slice. Prioritize integrating these clients into Fleet's Cloudflare and Swift projects
and verifying their real events end to end. App Store Connect belongs to a different project and
is outside App Health's scope.

## Focused dashboard scope

The owner narrowed scope to an easy-to-consume product rather than full analytics-suite
parity. The dashboard has Overview across projects, then Analytics, Events, Backend,
and Settings for a project and environment. Backend groups API monitoring, Logs,
and Diagnostics. Setup is part of the relevant product; it is not another product.
Dashboard routes use those names directly, without old route aliases. Persisted data
and ingestion contracts are independent of dashboard navigation.

The required delivery includes rich explicit browser/server events, consent and
own-visit exclusion, editable goals/funnels/saved segments, recorded payments and
refunds, Stripe/Polar/Dodo connections and bounded import/reconciliation, workspace
roles/invitations, and scoped revocable API/MCP access. Keep those within the
existing navigation and privacy boundary. Production account activation remains
separate from local implementation and verification.

Advanced identity-linked attribution and LTV, compatibility layers, expanded
period/timezone/history infrastructure, richer geography/live journeys, Telegram,
bot/WebMCP analytics, expanded agent tooling and self-host lifecycle automation
are outside this delivery. Do not keep the core delivery open for these extras.
Experiments remain outside scope; Clarity covers replay and heat maps.
