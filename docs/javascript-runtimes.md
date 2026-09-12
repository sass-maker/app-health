# JavaScript runtime verification

`scripts/verify-js-runtimes.mjs` is a credential-free runtime canary for the
published Node package build. It imports the actual built core and web exports,
sends an endpoint batch and an explicit server log through a real local HTTP
collector, and sends a browser log through the same collector. The collector
returns one transient `503` for each server batch and verifies that the retry
reuses the exact batch body and ID. It also verifies that server requests carry
the private bearer header while the public browser logger does not.

Run it after building the SDK:

```sh
rtk proxy mise exec node@24.20.0 -- pnpm --filter @saas-maker/app-health build
rtk proxy mise exec node@24.20.0 -- node scripts/verify-js-runtimes.mjs
```

The canary runs the same built exports sequentially under the installed Node,
Bun, and Deno binaries. The core contract currently accepts only `runtime:
'node' | 'worker'`; Bun and Deno therefore use the existing `node` wire value
and are recorded as compatible host runtimes through the environment field.
This is transport compatibility evidence, not a claim that they are native
runtime enum values.

Observed matrix (2026-09-12 local run):

| Host | Binary                                | Result   |
| ---- | ------------------------------------- | -------- |
| Node | Node 24.20.0                          | verified |
| Bun  | Bun 1.3.14 (`/opt/homebrew/bin/bun`)  | verified |
| Deno | Deno 2.9.6 (`/opt/homebrew/bin/deno`) | verified |

The existing Cloudflare workerd and Chromium sample remains a separate
verification path. This canary uses no provider resources, credentials, or
network services.
