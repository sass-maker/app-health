# shadcn source boundary

The UI primitives in `shadcn-sources.json` are copied from the MIT-licensed
shadcn registry, with source URLs, upstream hashes, local hashes, and adaptation
notes. Preserve complete primitives where the product uses them; remove whole
components that have no callers.

These exact files are excluded from authored-code coverage, complexity, and
duplication budgets, and from unused export/type warnings. They remain in
formatting, lint, type checking, dependency checks, the production build, and
interaction tests. Unused whole files still fail Knip. Product components,
analytics hooks, and theme behavior are subject to the original quality budgets.
No numerical threshold is reduced by this boundary.

`scripts/shadcn-vendor.mjs` verifies paths, provenance, and local hashes before
quality checks. Changes to a primitive require reviewing the upstream adaptation,
updating its manifest hash and notes, and checking affected interactions. Do not
place product behavior in this directory to bypass a quality budget.
