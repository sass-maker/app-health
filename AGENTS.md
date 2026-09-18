## Repository operating rules

This repository is independently operable. Its tracked instructions and
commands are authoritative; no sibling Fleet checkout is required. Protect
production stability, keep changes scoped, verify work with repo-local checks,
and record durable follow-up in this repository's GitHub Issues.

## Project

- **Stack**: pnpm TypeScript workspace (Vite + React, Cloudflare-compatible Worker, Node/Express SDK) plus a Go 1.22 `net/http` SDK
- **Local dev**: `pnpm install && pnpm run check`; see the commands below for web and Go
- **Deploy**: Production adapters are implemented but resource provisioning and deployment require explicit approval

## Local commands

Run from the repository root unless noted.

| Command | Purpose |
| --- | --- |
| `pnpm install` | Install TypeScript workspace dependencies. |
| `pnpm run check` | Full Fleet code-health gate across TypeScript and Go. |
| `pnpm run format` / `pnpm run format:check` | Prettier write / verify. |
| `pnpm run lint` | ESLint (flat config). |
| `pnpm run typecheck` | `tsc --noEmit` across all workspace packages. |
| `pnpm run test` | `vitest run` across all workspace packages. |
| `pnpm run build` | Build all workspace packages (web uses `vite build`). |
| `pnpm run quality:coverage` | Ratcheted Vitest coverage for all TS surfaces plus Go statement coverage. |
| `pnpm run quality:unused` | Strict Knip unused file/export/type/dependency check. |
| `pnpm run quality:complexity` / `quality:duplication` | Ratcheted production complexity and clone checks. |
| `pnpm --filter @app-health/web dev` | Vite dev server for the operator shell. |
| `cd packages/go && go test ./...` | Go contract tests. |
| `cd packages/go && go vet ./...` | Go vet. |

CI (`.github/workflows/ci.yml`) runs the aggregate `pnpm run check` gate and a
separate Go compatibility job that retains the tagged Echo release canary.

## Boundaries

- Edit `openspec/` and `PROJECT_STATUS.md` only through the OpenSpec workflow or parent review.
- Do not run `wrangler deploy`, create Cloudflare resources, or touch
  credentials, env files, or production configs without explicit production
  approval. Local V0 remains credential-free.
- Production mode fails closed unless D1, Analytics Engine, the owner secret,
  query-token, and hostname configuration are complete. Ingest remains
  separately bearer-key authenticated.
- Endpoint telemetry collects only method, normalized route, status, duration,
  response payload byte count, timestamp, and optional release. Never add
  capture of headers, cookies, query values, route parameter values, bodies,
  identity, stacks, or spans.
- Application logs (`/v1/logs`, `client.log()`, `createWebLogger`) are the
  deliberate exception: explicit, owner-authored events carrying what the
  caller passes. Never derive a log from request traffic, keep the 30-day
  retention bounded, and never accept a browser batch without a public key
  whose origin allowlist matches the request `Origin`.

## Wave status

- The local endpoint V0 is complete. The production Cloudflare implementation
  is tracked in `openspec/changes/deploy-cloudflare-endpoint-health-v0/`; only
  production provisioning and canary verification remain.
