# CTA browser-count rendered review — 2026-10-02

Lane: preserve. Direction: daily-briefing-editorial. Reviewer: Codex root direct review; no independent reviewer or owner acceptance claimed.

Preflight passed before UI implementation using the separate fleet.design-review.v2 receipt. Historical receipt remains untouched. PRODUCT.md, DESIGN.md, current canonical purposeContract and original approved briefing were inspected.

## Defects found and fixed

- Before: expanded desktop action list showed events only; phone/tablet cards omitted the per-action list. Reused one native ActionDetails disclosure across both layouts and added the existing distinct-browser field.
- First after: narrow desktop column fragmented benchmark_opened and the count line. Widened Actions within the fixed ledger.
- Second after: narrower source column split the source name and percentage into competing flex children, truncating Google. Stack both in one child; final wide screenshots show the full label and percentage.
- Null browser counts say Browser count unavailable. Measured zero remains 0 browsers. Counts stay per named action with overlap warning; no cross-action sum or people claim.

## Rendered observations

### Hierarchy

The existing completed-day metric rail and Every project ledger remain primary. Per-action browser counts appear only in a closed-by-default disclosure beneath the unchanged action total.

### Typography

The first desktop pass broke benchmark_opened across lines. Widening Actions from 10 to 16 percent makes this name and its 17 events / 3 browsers line legible. Event names remain monospace; counts and qualifications use existing small sans tokens in both themes.

### Composition

After reducing Top source and Responses widths, a first pass truncated Google. Grouping source name and share into one stacked child fixes that defect; the final 1440px view shows Google and its full share. Expanded CTA details increase row height deliberately; collapsed ledger remains compact.

### Identity

Retains App Health sidebar, dated report, browser/event measurement vocabulary, health qualification and ranked project ledger from the approved Daily briefing. No new theme, artwork, font or generic component surface.

### Interaction

Native details starts closed. Focus plus Enter opens the same action details on desktop and cards. Fixture browser checks verify measured 17 events / 3 browsers, sampled browser-unavailable state, and measured 0 events / 0 browsers; summary target is 44px with visible focus ring.

### Responsive

Rendered 390/768/1440 in light and dark. Phone/tablet cards expose the same counts instead of losing the capability. The readability/overflow check passes at all six states; long names wrap and the source button retains its meaning.

## Verification and limits

- 17 focused DailyEngagement/ProjectsView unit tests passed, including the new repeat/distinct/unavailable/zero regression across desktop and mobile DOM.
- Six dedicated fixture browser states passed at the three required widths in both themes, with actual keyboard opening, visibility assertions and readability/overflow checks. Counts are synthetic QA fixtures, not live telemetry.
- Web typecheck, scoped lint and production build passed. No new network request, query, dependency or tracking hook is introduced.
- Separate existing daily-engagement browser suite now exercises the disclosure by keyboard in both layouts.
- Screenshots isolate the ledger after filtering. Existing demo health/alert fixture state is not production service evidence; live owner read remains the release gate.
- Pinned detector not qualified for this scope: the review browser uses intercepted owner-report fixtures; an anonymous standalone scan cannot reproduce this state. Detector is unknown, not Clean.

## Review judgments

Critique 36/40: hierarchy 7/8, typography 7/8, composition 7/8, identity 7/8, interaction 4/4, responsive 4/4. Deductions reflect small secondary text, extra expanded-row height and deliberately preserved existing identity rather than a new design.

Audit 18/20: purpose 4/4, accessibility 5/6, behavior 4/4, responsive 3/3, performance 2/3. No formal screen-reader session or new field performance benchmark was run; existing semantic/keyboard/contrast checks and production build are proportionate evidence.

Zero unresolved P0/P1 in the changed surface. Scores are review judgments, not owner acceptance. Remaining product work is distinct: exact visitor-day qualification, sustained latency recovery, and eight historical server-activity Unknown rows.
