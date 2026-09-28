# Daily Fleet engagement report

The App Health **Overview → Daily engagement** section is the owner's chosen
destination for the daily 55-product report. It loads the latest completed
Asia/Kolkata calendar day on opening, follows the next completed day at India
midnight or when the tab regains focus, and can read a manually selected older
date until the owner chooses **Latest**.
The owner-only API is `GET /v1/reports/daily-engagement?date=YYYY-MM-DD`.
Responses are computed on request; no scheduled snapshot or outbound delivery
is part of this source change.

## What a row means

- Scope comes from active or primary rows in the workspace's
  `catalog_project_imports`. The response
  reports the imported count and warns when fewer than 55 active products are
  present. Missing imports cannot have rows. Import is a declaration only; it
  does not prove an installed SDK, accepted event, or live coverage.
- Browser visitors are distinct recognized browser hashes in a production
  environment for that day. They are browsers, not people. Sampled visitor
  groups are shown as unknown because distinct counts cannot be scaled.
- Primary CTA names must be qualified per product before counts appear. The
  checked-in CTA policy keeps Clarity candidates separate from browser events
  that have a production ingest and authenticated Events receipt. Unqualified
  products remain unknown. Dates before the first qualification on 2026-09-28
  stay unknown rather than showing a retrospective zero.
- Analytics Engine scales sampled CTA event rows into estimates. Each affected
  action carries `estimated: true` and is labeled “Approx.” in the dashboard;
  observed unsampled action rows remain exact. If any CTA group is sampled, the
  report omits configured actions without an observed row because sampling may
  have hidden them. A sampled visitor row without any CTA rows leaves CTA
  counts unknown. Sampled distinct visitor counts remain unknown because
  distinct counts cannot be scaled.
- `feedback.submitted`, `waitlist.join`, and `newsletter.subscribe` are counted
  from stored production App Health logs. Central SaaS Maker logs are attributed
  only when their project ID or slug resolves to an imported catalog product.
  Submission text and email are never included in the report.
- Native sessions and API engagement are currently unknown. Request totals in
  Watchtower are not a measure of visitors.
- Unknown means the source was unavailable, unconfigured, or had no qualifying
  receipt. Zero appears only where the source was measured.

## Qualification before a complete report

The workspace import reached 55 of 55 active products on 2026-09-28. This
proves report row coverage, not live instrumentation. Each product still needs
an appropriate runtime-specific CTA policy, source integration, a successful
accepted event, and an authenticated dashboard receipt before its CTA can be
counted. See
[`fleet-engagement-rollout-55.md`](fleet-engagement-rollout-55.md) for the
source inventory. The owner authorized production activation on 2026-09-28;
deployment and live qualification are recorded separately from source checks.

## In-app alerts

The owner-selected alert destination is the App Health Overview feed. It reads
the latest 50 production `feedback.submitted`, `waitlist.join`, and
`newsletter.subscribe` logs from the workspace's 30-day retention window,
refreshes every minute and when the tab regains focus, and shows only project,
event, and time. Central SaaS Maker logs are mapped by exact catalog project ID
or slug. The feed never returns email, submission text, or log properties.
