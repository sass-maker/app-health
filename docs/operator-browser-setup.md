# Operator runbook: authenticated browser setup

This runbook provisions an App Health project environment and an origin-bound
browser key through the owner API. It is for an authenticated operator or an
AI agent running inside an already authenticated dashboard session. The agent
must use the dashboard's same-origin authenticated browser requests, or receive
an owner credential through a trusted runtime. Never print, paste into chat,
log, shell arguments, source files, or telemetry any owner credential or
private ingest key. Never bypass authentication with direct SQL.

## API workflow

From an authenticated browser page on `https://health.sassmaker.com`, use
same-origin requests so the browser supplies its session cookie without exposing
it to the agent:

```js
const response = await fetch('/v1/apps', { credentials: 'same-origin' });
if (!response.ok) throw new Error(`Owner API: ${response.status}`);
const projects = await response.json();
```

For writes, use the same origin and credentials with `method: 'POST'`,
`headers: { 'content-type': 'application/json' }`, and `body: JSON.stringify(...)`.
A trusted non-browser runtime can alternatively supply the existing owner
Authorization header in memory. Never place its value in shell arguments.
First list projects and environments and reuse matching IDs; do not create a
new project or duplicate environment on every run.

The authenticated `GET /v1/apps` response is the ownership check. A `401`
means the request has no valid owner session; a `403` means the credential is
scoped away from the requested project. Do not retry by changing the route or
using a database connection.

Create a project and its initial environment with:

```json
POST /v1/apps
{
  "name": "StorageDaddy",
  "environment": "production",
  "key_scope": "environment"
}
```

The `201` response is `{ "app", "environment", "key" }`. Save the raw
`key.key` only in the trusted runtime's secret handoff: it is a private ingest
key and is shown once. The response's `app.id` and `environment.id` are safe
operator receipt fields. For an existing project, add an environment with
`POST /v1/apps/:appId/environments` and `{ "name": "production" }`; that
response contains a one-time private key as well.

Check or select capability state with:

```text
GET /v1/capabilities?app_id=<app-id>&environment_id=<environment-id>
PUT /v1/capabilities?app_id=<app-id>&environment_id=<environment-id>
{ "enabled": ["analytics"] }
```

The capability receipt records setup state; it is not proof that a browser has
sent data. A heartbeat can establish active presence only where the browser
contract says so; an empty browser batch or rejected request does not establish
a successful installation receipt.

Create the website's public browser key with the exact HTTPS origin:

```json
POST /v1/public-keys
{
  "app_id": "<app-id>",
  "environment_id": "<environment-id>",
  "allowed_origins": ["https://example.com"]
}
```

The `201` response is `{ "key": "ahk_pub_...", "record": { ... } }`.
The raw `ahk_pub_...` value is shown once. It is safe to embed only on the
listed origin and is independent from the private ingest key. Reuse an active
public key when it is available; do not rotate a private key merely to install
browser analytics. To inspect existing public keys use authenticated
`GET /v1/public-keys?app_id=<app-id>`. Revoke the exact public key only when
the owner intends to stop that origin.

Install the generated tracker snippet in the website with the public key,
project scope, `data-identity="persistent"` (or the explicitly chosen privacy
mode), and `POST /v1/browser` as its endpoint. The website must be deployed
before a live browser receipt can be claimed. Verify the origin-bound key by
checking that an allowed-origin request is accepted and an unlisted origin is
rejected with `403`; do not use a private key in the browser.

## Trusted setup receipt

The bounded StorageDaddy provisioning receipt is:

```text
app:         app-3262e567-f7cc-48bc-a528-4e3845185b41
environment: env-edef7501-b44d-460c-a4db-383a9b92fda1
origin:      https://storagedaddy.significanthobbies.com
```

The key provision is live: the allowed-origin request returned `202`, while a
request from another origin returned `403` using an empty heartbeat. The
StorageDaddy website was not deployed at the time of this receipt, so it is a
provisioning and origin-isolation proof, not live website traffic proof.

An administrative D1 provisioning action was authorized once for this receipt.
Keep the owner API as the normal path; do not promote that one-off SQL action
into an operator workflow or use it to bypass ownership, key storage, origin
checks, or revocation.

## Runtime handoff and evidence

For an AI authenticated setup, the browser or trusted runtime should perform
the owner API calls and return only a sanitized receipt containing IDs, origin,
HTTP statuses, capability state, and timestamps. It may pass the public key to
the website installation step. It must not return the owner credential, private
ingest key, cookies, authorization header, raw key response, or clipboard
contents.

An enabled preference is configuration only. A connected capability indicates
that at least one valid event was received; it does not prove that a particular
page view, download, or human visit occurred. Use the
authenticated dashboard report and a fresh browser request after deployment to
verify actual traffic.
