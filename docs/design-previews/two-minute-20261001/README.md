# Two-minute portfolio briefing: direction review

Spec: https://github.com/sass-maker/app-health/issues/137

These are static visual hierarchy probes, not shipped screens. All shown counts, sources, changes and health states are illustrative. The complete implementation keeps every one of the 55 project rows, including quiet/internal projects, and preserves applicability, missing data and counting-unit labels. No implementation or production changes are part of this review.

## A — Morning briefing (recommended)

Editorial summary, totals and ranked change/source cards lead; a complete sortable project ledger follows. The owner first learns what moved and needs attention, then scans each project. Graphite surface and system sans retain the selected Daily briefing direction. On mobile the signal cards stack and project rows become compact expandable cards. Project or signal opens the scoped analytics/source/backend report. Risk: summary occupies vertical space; keep it to a small number of significant signals and avoid repeating empty cards.

## B — Portfolio radar

A visual map plots activity against comparable absolute change; a neighboring signal rail explains growth and problems. The ledger provides exact values below. Select a plotted project to inspect its sources. Source colors distinguish the focus rather than represent health. On phones the ranked signal list leads and the chart becomes optional. Risk: sparse and low-volume traffic makes the chart less useful and overlapping labels require careful handling. Non-comparable projects remain in the full ledger without fabricated chart coordinates.

## C — Project ledger

A compact total strip and complete table lead. Selecting a row opens its source mix, action intent and relevant insight alongside it. Dense typography supports repeated project scanning; mobile uses an expandable detail sheet. Risk: significant signals can be missed in the table; ranking/filtering must make the biggest meaningful changes easy to reach.

## Shared requirements

- Activity/source period is the selected completed India day. Last-24-hour health is labeled independently.
- Sources use recorded referrer and campaign data. Show the measurement unit and denominator; do not invent unique visitors from pageview shares.
- No-referrer, unknown coverage and not applicable remain distinct.
- Download clicks remain intent. Baselines require meaningful volume, sufficient coverage and comparable instrumentation/filtering.
- Use existing shadcn project-native cards, tables, badges and controls. No new production dependency.
- Only after owner selection: implement bounded cached aggregate comparisons/source summaries, lazy product/source drill-downs, responsive/keyboard interactions and relevant regressions.
