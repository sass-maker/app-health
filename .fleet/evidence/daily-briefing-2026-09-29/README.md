# Daily briefing design evidence

The `after-*.jpg` images are local responsive QA captures, not production dashboard evidence. The browser tests inject an amber QA banner and synthetic counts. Product names, catalog IDs, and source applicability come from the 2026-09-29 repo-local fixture snapshot; no owner session or production credentials are used.

| Viewport | Capture          | Verified in browser test                                                                                                                         |
| -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 390 px   | `after-390.jpg`  | 55 mobile product cards; known zero remains `0`; an applicable source without a receipt remains `Unknown`; final card can be scrolled into view. |
| 768 px   | `after-768.jpg`  | Same mobile inventory and below-fold checks.                                                                                                     |
| 1440 px  | `after-1440.jpg` | 55 ledger rows; the horizontal ledger scrolls to the `Server requests` column; full inventory is restored after evidence filters.                |

The focused `ProjectsView` tests separately verify that measured slow requests stay in the request-issue queue, remain separate from unconfigured inventory, and preserve the exact issue count from the supplied API fixture. Production live state and post-deploy screenshots remain for the owner to verify after review and deployment.
