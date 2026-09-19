# Catalog import declarations

`POST /v1/catalog/import` accepts an authenticated account session and a body
with `schema_version: 1` and one to ten `projects`. Bodies are limited to 32 KiB.
Each project supplies `catalog_id`, `name`, and `lifecycle`; `repository` (a
public GitHub repository URL), `hostname`, and `existing_app_id` are optional.
Unknown fields, duplicate catalog IDs, credential-bearing URLs and oversized
batches are rejected. Send only the curated declaration fields, never a private
catalog wholesale.

Canonical IDs are preserved in workspace-scoped mapping records. Existing App
Health IDs, ownership, credentials, telemetry and evidence bindings are never
rewritten. An explicit `existing_app_id` can link only an active project already
owned by the authenticated workspace. Names and domains never auto-claim a
project. A new declaration creates an uninstrumented project and production
environment without ingestion keys or accepted-data receipts.

All records in one request commit in a D1 transaction. Retrying the same parsed
declaration returns the same App Health ID. Reusing a canonical ID with changed
metadata or trying to map a second canonical ID to the same project returns a
conflict, preserving the earlier declaration. There is no implicit metadata
update or deletion operation. A conflict rolls back the entire batch, including
any preceding project creation. Use batches of ten for larger catalogs.

The response reports `verification_state: "declared"`. This is metadata supplied
by the account, not proof of hostname/repository ownership, an instrumentation
claim, or a provider evidence import. Domain proof, activation, transfer of new
provider bindings and an owner UI remain separate incomplete work. Existing
bindings on explicitly linked projects remain untouched.

## Activation

Additive migration `0018_catalog_imports.sql` must exist before the route can
succeed. It is replayable and its triggers enforce transactional workspace scope
and immutable import identity. This implementation does not apply that migration
or perform any production import. Missing schema returns unavailable without a
successful-import claim. Rollback to the previous Worker leaves the additive
tables and existing projects intact; it does not delete imported declarations.
