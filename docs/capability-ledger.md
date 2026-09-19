# Capability ledger

`GET /v1/capabilities/ledger?app_id=...&environment_id=...` returns the versioned
implementation ledger to the authenticated project owner. It uses the same
project/environment authorization as capability management. Ingestion keys
cannot administer or read this ledger. Responses are `no-store` and include no
credentials, identity records, telemetry rows, or private catalog data.

`features` describes implementation status: `available`, `partial`, `planned`,
or `deferred`, with a concrete explanation. This is not a production activation,
installation, or full-product-parity claim. Deferred features remain unimplemented.

`collection` separately returns each environment's analytics, endpoint and log
preference and first/last accepted-data receipts. A disabled channel can retain
historical receipts; a quiet channel does not lose its connection history.
An analytics receipt does not establish that any specific named event, funnel,
provider integration, or other feature has been verified. Missing repository
state returns an error instead of invented available/connected state.

The ledger follows the focused-product decision in issues #58 and #60. It adds
no storage, resource, migration, or UI surface. Update its definitions when
verified implementation changes; do not use it as a substitute for workflow
receipts or deployed-version verification.
