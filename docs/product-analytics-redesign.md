# App Health product analytics redesign

Owner direction, 2026-09-12. Tracked in App Health #58.

## Owner correction after initial handoff

The owner found unreadable white endpoint panels in dark mode. The initial review covered the new
analytics screens but did not establish full-product theme quality. Its completion claim is
withdrawn. App Health is a flagship product and will use standard shadcn components across the
remaining views, with full route/state browser verification before the next handoff.

The immediate causes were legacy hard-coded surfaces, text using shadcn's background token
`--muted`, and incorrect CSS layer registration that allowed preflight to reset legacy spacing.
Fix the integration and remove conflicting legacy styles as components migrate; do not conceal
the mismatch with another collection of theme overrides.

## Product and audience

App Health is a Fleet product for product managers, founders, and teams who need
to understand traffic and intentional user actions across their products.
Application health supports investigation; it does not lead the experience.
Site Health remains Fleet's separate internal evidence dashboard.

## Implementation plan

1. Make web analytics the default dashboard route. Give Events equal visibility.
   Retain application health, logs, and collection details as secondary views.
2. Use actual shadcn/ui components, Radix behavior, and shadcn/Recharts charts.
   Deliver one coherent product interface, replacing the rejected custom layout.
3. Provide event names, occurrences, last received, time trends, project/period
   filtering, and per-event page/referral-source drill-down. Reports must use
   collected events and distinguish page views from active browser sessions.
4. Create a product-led landing page with a labeled illustrative preview, clear
   product value, and working dashboard entry. The footer exists here only.
5. Default to dark mode, with a persistent light-mode choice. Both themes must
   cover navigation, dialogs, menus, graphs, tables, loading and error states.
6. Verify keyboard/mobile interactions, API isolation, and responsive layouts
   at 390/768/1440. Run independent design review and the full repository gate.

## Ownership

- Sol (`gpt-5.6-sol`) owns frontend implementation, frontend tests, theme/design
  context, and screenshot evidence.
- Parent owns report API verification, account/security checks, product metadata,
  tracking, integration, and final review.
- Independent read-only design assessments follow the implementation.

No commit, push, deployment, production resource, migration, or credential change
is authorized. Existing Google activation and broader funnels/revenue work remain
separate. Do not imply those capabilities are available from design previews.

## Acceptance

A product person opens the dashboard and immediately sees web analytics, can
open Events and inspect a real event's trend and origin, and can navigate the
same workflow on a phone. The landing page communicates that purpose without
requiring knowledge of backend telemetry. Dark/light modes are complete, the
dashboard has no footer, and the implementation uses the checked-in shadcn
components listed in `shadcn-sources.json`.

## Integration verification

- Account/report tests: 15 passed, including workspace isolation, foreign-project
  rejection, invalid filters, missing configuration, and provider failure.
- Worker suite: 156 passed; coverage 94.62% lines, 87.12% branches, 96.2% functions.
- Native local workerd canary: account ownership, OAuth initiation, report shape,
  queue/archive delivery, authenticated presence stream, and sign-out passed.
  Google callback and production activation remain unverified.
- Canonical App Health purpose and prominent tools updated in Site Health;
  dossiers regenerated from retained observations and SaaS Maker projection synced.
  Site Health build and 150/151 tests pass; its unrelated existing StorageDaddy
  technology-list limit fails the complete check. That project was not edited.
- Aggregate App Health `pnpm run check` passed under Node 24.20.0 after the
  dashboard fixes, with unchanged quality thresholds. Web coverage is 93.88%
  lines and 88.73% branches; all dependency, complexity, duplication, SDK, and
  runtime gates passed.
- Independent follow-up: usability 33/40, technical audit 17/20, no
  unresolved P0/P1. The reviewer created a local project, installed its generated
  tracker, sent `review.completed`, and verified its event trend/page/source view.
  Landing first-viewport comprehension passes at 86/100 desktop and 85/100 mobile.
  Remaining P2 work includes optional backend onboarding placement, compact empty
  states, and measuring/splitting the approximately 796 kB raw dashboard bundle.
