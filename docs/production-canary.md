# Production SDK canary

Use this bounded check to qualify the deployed App Health path without
touching an adopted service.

1. Confirm the checkout is clean and record the full source SHA. Reuse the
   existing owner credential for an ordinary canary. Only when owner access is
   unavailable, perform the scoped Worker `OWNER_AUTH_TOKEN` recovery and
   store the same value in Infisical project `Fleet`, environment `prod`, path
   `/`, key `APP_HEALTH_OWNER_TOKEN`, tagged `app-health`. Keep the value in
   process memory; do not place it in an argument, repository, or credential
   file.
2. For recovery only, upload the owner secret as a version tagged to the source
   SHA. Before promoting or retrying, verify that the latest uploaded version
   has the expected source tag, matches the checked-out source, and is the
   active 100% version. Then deploy the returned version at 100% and wait until
   an authenticated `GET /v1/apps` returns 200. If the owner route lags during
   rollout, poll and recheck the version state; do not blindly rotate again.
   Keep `ANALYTICS_ENGINE_QUERY_TOKEN`, D1, Analytics Engine, routes, and
   existing consumer records unchanged.
3. Create one clearly named disposable app/environment through the owner API.
   Run the Node SDK with the disposable ingest key against
   `https://ingest.sassmaker.com/v1/ingest`, emit two successful requests and
   one 503 request on a synthetic normalized route, flush, and poll the owner
   aggregate for up to 60 seconds.
4. Pass only when installation is `connected`, request delta is at least 3,
   error delta is at least 1, and p50/p95 are finite. Revoke the exact
   disposable environment key after the receipt. The current V0 API exposes
   key revocation but no app archive or delete route, so retain the aggregate
   record and report the cleanup limitation.
5. For a browser proof, use the Infisical UI Copy action without revealing the
   value, paste it into the dashboard password field, unlock, select the exact
   canary app/environment, and refresh the endpoint view. Lock the dashboard
   afterward and replace the clipboard with nonsensitive text without reading
   its contents. Never send the owner value through agent messages, tool
   arguments, shell history, or files.

The sanitized receipt must contain only app/environment IDs, source/version
identifiers, connection state, request/error counts, metrics availability,
percentiles, and timestamps. Never record owner or ingest key values.
