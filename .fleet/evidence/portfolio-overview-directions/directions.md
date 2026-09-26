# Cross-project overview direction set

All previews use illustrative metrics, preserve App Health's existing shadcn graphite system, and keep browser/native usage separate from HTTP request traffic. They are decision probes, not production UI or live telemetry.

## A. Fleet ledger — recommended

- **Screen job:** answer exactly which project/environment is used, healthy, stale, dark, or unconfigured.
- **Layout:** workspace totals above a sortable matrix with distinct usage, request-health, freshness, and state columns.
- **Interaction:** sort/filter by attention, traffic, errors, latency, freshness, capability, or environment; selecting a row opens the existing project view.
- **Signature:** one audit-grade operating ledger where unknown data is visibly different from zero and N/A.
- **Risk:** desktop density; mobile must use prioritized project cards rather than squeeze the table.

This is the strongest fit for 56 active projects and rollout reconciliation because it preserves exact comparisons and makes gaps explicit.

## B. Signal board

- **Screen job:** understand product use and request reliability as two adjacent but deliberately different systems.
- **Layout:** ranked usage bars on the left, request-health cards on the right, and compact capability lanes below.
- **Interaction:** selecting or hovering a project highlights it across both lanes; capability lanes open setup or detail.
- **Signature:** paired lanes prevent requests from being mistaken for users while making coverage visually memorable.
- **Risk:** card density and ranking truncation scale less gracefully to the full active portfolio; exact comparisons require more movement.

This is the clearest explanatory direction and the strongest at teaching the measurement model.

## C. Watchtower

- **Screen job:** surface what changed or needs attention before showing healthy projects.
- **Layout:** a triage queue, a request-volume/error/latency field, and a compact healthy-project strip.
- **Interaction:** attention items lead to setup or investigation; the reliability field supports brushing and drill-down.
- **Signature:** an exception-first operational watchtower that makes request safety the opening story.
- **Risk:** quiet or low-usage products can become too easy to overlook, and the scatter view is weaker when few projects have live endpoint telemetry.

This is the strongest incident-prevention direction but the weakest complete inventory view.
