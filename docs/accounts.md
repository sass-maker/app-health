# Google accounts and project ownership

Tracking: https://github.com/sass-maker/app-health/issues/58

This is the first App Health account slice. Site Health remains the separate
internal Fleet dashboard. The existing endpoint pipeline and manual logs continue
to work. Account milestones emit only server-side `signup.completed` and
`project.created` events, with empty properties and no profile, project
identifier, or credential data.

## Implemented locally

- Better Auth 1.7.4 handles Google OAuth, state/PKCE, encrypted provider tokens,
  secure HttpOnly cookies, seven-day D1 sessions, and server-side sign-out.
- Origin/CSRF checks are explicitly enabled, including in tests. Cookie API
  mutations require the dashboard origin. The ingest host cannot serve auth.
- First verified sign-in creates one personal workspace, idempotently. Returning
  sessions reuse it without writing the workspace row on every request.
- Project creation and workspace ownership are one D1 batch. All existing owner
  routes check app scope, including key reads and revocation.
- New accounts cannot see or claim legacy projects. When accounts are enabled,
  the legacy owner key only accesses unclaimed projects. Existing project bearer
  keys remain scoped to their project. No automatic import/claim endpoint exists.
- The dashboard resumes account projects, switches projects/environments, adds
  another project, and signs out. Keys are shown once and never persisted in
  browser storage. Only the selected project's metadata is stored locally.

Better Auth is the sole new production dependency: implementing OAuth validation,
provider-token encryption, cookie/session lifecycle, and CSRF ourselves would
create unnecessary security and maintenance risk. Miniflare is test-only and is
pinned to the version already used by Wrangler.

Account records contain the Google name/email/profile and authentication metadata;
these are distinct from endpoint telemetry. Never pass account credentials or
profile information into the telemetry pipeline. Better Auth session and auth
rate-limit metadata has a bounded scheduled cleanup: at most 1,000 expired
session rows, 1,000 verification rows, and 1,000 stale rate-limit rows per
hourly invocation. User and account rows are never removed. The analytics
privacy contract does not imply an anonymous login.

## Local proof

`pnpm --filter @app-health/worker exec vitest run test/accounts.test.ts` runs the
account migrations against an ephemeral real Miniflare D1 database. It
exercises actual Better Auth session cookies, isolation, revocation, expired and
unverified accounts, OAuth initiation, and rejected state/foreign callbacks.

`pnpm run check` checks the entire repository, including browser/Worker tests,
SDK canary, builds, coverage ratchets, Go, dependencies, and code-health gates.
It also runs `pnpm --filter @app-health/worker run verify:accounts-runtime`: an
isolated dry-run bundle and workerd/D1 smoke test with Node compatibility enabled.
The test covers config lookup followed by authenticated requests across Worker
request lifetimes, workspace creation, project ownership, OAuth initiation, and
sign-out. It disables external provider requests. A cached auth context can leave
D1 work attached to an earlier Worker request, so auth instances are request-local.

The ordinary Vite workflow remains credential-free and does not emulate a Google
account. Browser UI fixtures are not proof of a successful Google callback.

## Production readiness — deployment pending

The feature remains deployment-gated. Production preparation is complete for the
`app-health-browser-events` queue and dead-letter queue, the
`app-health-browser-history` R2 bucket with a 30-day lifecycle, the Fleet OAuth
project and scoped Google client, the Worker Google and Better Auth secrets, and
additive migrations `0007_accounts.sql` through `0011_account_retention.sql`.
The applied migrations have a private backup. Worker code has not been deployed,
and a real Google callback has not been verified.

After explicit authorization, activation requires:

1. Deploy the prepared Worker code and verify the applied schema while confirming
   legacy rows remain unclaimed. The local runtime test uses `nodejs_compat` and
   compatibility date `2026-07-22`; it does not establish deployed behavior.
2. Enable `APP_HEALTH_ACCOUNTS=enabled` after deployment. Missing
   configuration fails closed, and the Google button only appears when configured.
3. Verify real Google signup, returning login, two-account isolation, project
   creation, ingest, and sign-out against the deployed version.

Set `APP_HEALTH_ACCOUNTS=disabled` to turn off Google entry. Once the ownership
schema exists, legacy access stays restricted even if the flag is removed.
Keep account tables and ownership mappings during rollback. Existing app/environment IDs and ingest keys are not rewritten.
Team access, explicit legacy import, and customer billing are not included in
this account slice. Browser analytics and self milestone delivery have a
separate integration-readiness record.
