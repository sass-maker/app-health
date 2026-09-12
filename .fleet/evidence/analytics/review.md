# Browser analytics review — 2026-09-12

Scope: App Health Overview, browser installation snippet and small standalone
tracker. Preserves the incumbent App Health operational design.

## Actual local browser canary

- Created origin-bound browser keys through the local API for demo-app and
  Storefront canary (production environment). These are disposable local data.
- Loaded the actual `/tracker.js` script in two browser pages. Each submitted
  one automatic page view and one manual event; each reported accepted=2,
  dropped=0, retries=0, queued=0.
- The real `/v1/analytics` response and Overview showed both projects, each with
  one active session, one page view and one manual event. The total was two. Reloading the scripts for the final capture added a second page view to each project; the captured totals reflect that real local activity.
- Captured 390, 768 and 1440 pixel screenshots. Document scrollWidth equaled
  viewport width in every case. One h1, no duplicate Overview mount. On mobile,
  project identity stacks above three aligned count columns.
- The runtime canary separately proves an authenticated, same-origin WebSocket
  through real workerd and SQLite Durable Objects. Vite uses a single workspace
  poll; local screenshots do not claim a WebSocket transport or a deployed site.

## Critique and audit

Critique: 35/40. The project-first rows, explicit metric labels and existing
header make this extension legible without introducing a new design system.
Remaining product depth belongs in #58 (drill-down reports, rich filters,
revenue and funnels), not decorative charts with invented data.

Audit: 18/20. No horizontal overflow at required widths. Buttons are native
keyboard-operable controls and retained visible focus. Empty and failure states
have next actions; a disconnected production stream hides stale live counts.
Every summary labels its 24-hour window and browser-session semantics. Actual
Google provider callback and production data quality are separate pending gates.

Impeccable advisory detector on apps/web/src returned no findings. No unresolved
P0 or P1 design issues in this local slice.

## Efficiency evidence

- Tracker served source: 5,929 bytes / 2,031 bytes gzip (Node zlib default).
  Test enforces at most 2,048 gzip bytes; no production dependency added.
- One workspace summary request and one production stream regardless of project
  count. Existing project-inventory refresh is separate. No per-project
  analytics network fanout.
- Conditional R2 batch creation and heartbeat exclusion proven in workerd;
  expiry and duplicate heartbeat behavior proven against SQLite.
- No production latency, throughput, sampling fidelity, or cost benchmark yet.

Full gate passed under Node 24.20.0 with `mise exec node@24.20.0 -- pnpm run check`. CI selects Node 24 to match the installed Cloudflare tooling requirements.
