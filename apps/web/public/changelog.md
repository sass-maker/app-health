# Changelog — App Health

> A curated record of shipped App Health outcomes. Roadmap work stays in GitHub Issues; this page records released capabilities.

Canonical: https://health.sassmaker.com/changelog

product history

## what changed, and what it means.

A curated record of shipped App Health outcomes. Roadmap work stays in GitHub Issues; this page records released capabilities.

## 2026-09-12 — analytics, logs, and endpoint health share one workspace

- Sign in with Google, create projects and environments, and connect each capability when you need it.
- Web analytics shows live sessions, historical sessions, page views, referral sources, and named events. Sessions are not unique people; sampled counts are labeled.
- Share an aggregate live page with a revocable link. Private logs, event names, and credentials stay in your dashboard.
- The JavaScript SDK ships endpoint adapters, explicit logs, and a public analytics viewer as separate imports.

## 2026-07-27 — one product key can now cover multiple environments

- SDK and OpenTelemetry traffic can select a bounded environment while sharing one product-scoped ingest key.
- The dashboard switches endpoint health, installation status, and retained failures together.

## 2026-07-25 — Cloudflare applications gained first-party adapters

- Hono middleware and a Pages Functions wrapper report trusted route templates without changing application responses.
- Delivery stays fail-open and can continue through the platform execution context after a response is returned.

## 2026-07-22 — the dashboard made collection boundaries visible

- Operators can inspect recent retained failures and the exact fields App Health accepts for an environment.
- The product explains aggregate storage, retention, and the request data it never collects.

## 2026-07-21 — endpoint health reached production

- Node, Go, and OpenTelemetry traffic can feed the same focused view of requests, latency, errors, and last-seen time.
- Every accepted route remains discoverable even when sampled metrics are temporarily unavailable.

This public changelog uses Microsoft Clarity to understand navigation and rendering. The owner-key unlock and private dashboard never load it.

## Related

[App Health](https://health.sassmaker.com/) · [Changelog](https://health.sassmaker.com/changelog) · [Source and roadmap](https://github.com/sass-maker/app-health/issues)
