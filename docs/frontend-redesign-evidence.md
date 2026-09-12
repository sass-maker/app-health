# Frontend redesign evidence

## Owner correction and scope

The first handoff missed legacy endpoint styling: white panels and low-contrast text remained
inside the dark dashboard. Its earlier analytics/landing review did not establish whole-product
quality. That completion claim is withdrawn.

This correction uses actual shadcn/ui registry components across the dashboard: sidebar, cards,
tables, selects, tabs, inputs, alerts, sheets, and confirmation dialogs. The old stylesheet was
removed rather than layered with more overrides. Shared semantic colors cover both themes.
The source manifest records upstream provenance, React 18 compatibility changes, and local hashes.

## Browser regression coverage

The committed Playwright suite runs against its own local server and checks actual rendered text
contrast, horizontal overflow, and footer placement. It is part of the repository check and CI.

- 54 cases: endpoint health, logs, and received data; populated, empty, and error states; dark and
  light themes; 390, 768, and 1440 pixel widths. Failure rows expand before their readability check.
- Four real local workflows: create a project, reveal its one-time service key, create a browser
  key, load the actual tracker, receive an accepted collection response, and revoke the key.
  Escape and Cancel must restore focus to the exact trigger. Both themes at 390 and 1440 pixels.
- 16 route checks: landing, changelog, web analytics, and events; both themes at 390 and 1440 pixels.
  Dashboard reports must respond successfully before inspection. Only the landing has a footer.

These checks caught and corrected light-mode text contrast failures as well as the malformed
PostHog bootstrap. They supplement visual review; they are not a complete WCAG certification.
Playwright attaches screenshots to route checks and retains traces/screenshots on failures.

## Independent review

Fresh reviews are recorded under `.fleet/evidence/app-health-redesign/standard-review-a/` and
`standard-review-b/`. They cover the redesigned secondary routes, installation and key states,
mobile keyboard interaction, and synthetic failures as well as the main analytics experience.
Clipboard failure handling and accessible snippet panels were added following that review.

## Product workflow proof and limits

An earlier independent local run created a project and origin-bound browser key, loaded the
actual tracker, sent `review.completed`, and observed the event with its pages and sources.
The new regression suite additionally verifies real local collection and key revocation.
Landing numbers are explicitly illustrative; the endpoint demo labels its seeded fixtures.

Google OAuth initiation, account ownership, sign-out, queue processing, archive, and scoped live
streams have local runtime checks. A real Google callback and hosted Cloudflare analytics remain
unverified and require provider configuration. No production migration or deployment was made.
The PostHog queue bootstrap no longer throws locally; external ingestion is not verified.

## Final validation

Full repository `pnpm run check` passed on Node 24 after the final changes, including all 74
browser cases, formatting, lint, types, builds, native runtime checks, coverage, unused code,
complexity, duplication, dependencies, suppressions, and repository hygiene. No thresholds were
relaxed. Fresh critique: 32/40; fresh audit: 16/20, with no P0/P1 found in their stated scope.

Root final screenshots in `standard-final/` verify dark/light endpoint health and mobile setup.
The complete mobile create form ends at y462 on a 390 by 844 viewport. Browser continuation now
precedes optional backend instructions. Shared Fleet promotional scripts are restricted to `/`;
tests assert that dashboard and changelog pages never load those scripts, in addition to checking
footer elements. This closes a gap discovered during the final screenshot inspection.

Remaining P2 design advisories: generous mobile endpoint spacing and the Events empty-state height.
The production build still reports a roughly 810 kB raw JavaScript chunk; route-level splitting
remains a performance follow-up, not a claim of completed production performance work.
