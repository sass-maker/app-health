---
title: "Public browser keys vs private server keys in analytics systems"
slug: "public-browser-keys-vs-private-server-keys-in-analytics-systems"
target_query: "browser analytics vs server telemetry"
search_intent: "Understand the architectural differences and security boundaries between client-side and server-side instrumentation keys"
meta_title: "Public Browser Keys vs Private Server Keys in Analytics Systems"
meta_description: "Learn how modern telemetry systems separate public browser tracking from private server ingestion using environment-scoped keys, origin allowlists, and targeted APIs."
---

# Outline

1. **Introduction:** The dual challenge of capturing full-stack application health. Why a single "API key" is dangerous when mixing frontend and backend telemetry.
2. **The Nature of Public Browser Keys:**
   - Deployed in untrusted environments (the user's browser).
   - Constrained by origin allowlists and rate limits.
   - Purpose: Web analytics (page views, sessions, named product events) and explicit browser logs.
   - Designed for revocation without breaking backend systems.
3. **The Role of Private Server Keys:**
   - Deployed in trusted environments (Node.js servers, Cloudflare Workers, Go services).
   - Unconstrained by origin, capable of submitting backend health and server logs.
   - Why they must remain secret (preventing malicious ingestion, protecting endpoint telemetry).
4. **The App Health Approach: Projects and Environments:**
   - How environment-scoped keys (e.g., staging vs. production) prevent data contamination.
   - Independent adoption of capabilities: Endpoint health, logs, and web analytics.
5. **Concrete Examples:**
   - Initializing the browser script with a public key.
   - Configuring the backend Node.js SDK with a private key.
6. **Internal Link Suggestions:** Opportunities for cross-referencing capabilities.
7. **Next Actions:** Auditing your current analytics integration.
8. **Source Notes (Non-publishable):** Internal references verifying claims.

---

# Public Browser Keys vs Private Server Keys in Analytics Systems

Building a comprehensive picture of application health requires capturing signals from two very different worlds: the frontend interfaces where users interact, and the backend services where business logic executes. You need page views and button clicks from the browser, but you also need latency percentiles, error rates, and structured logs from your servers.

A common mistake in early-stage analytics integration is treating all telemetry as equal and using a single "API key" across the entire stack. This approach compromises security and data integrity. Because frontend code is visible to anyone who visits your website, any credential embedded in it is fundamentally public. If you use that same credential on your backend, you expose your entire telemetry ingestion pipeline to unauthorized manipulation. A leaked universal key could allow an attacker to inject fabricated latency metrics, flood your error tracking, or corrupt your production database records.

Modern analytics architectures solve this by explicitly separating **public browser keys** from **private server keys**. This division ensures that each environment has the precise permissions it needs, bounded by appropriate constraints, without bleeding security risks across the stack. This article explores the mechanical differences between these credentials, the boundaries they enforce, and how to structure your telemetry deployment for maximum safety and data fidelity.

## The Nature of Public Browser Keys

When you embed a tracking script in a web page or a native application distributed to user devices, you are placing credentials in an untrusted environment. Anyone can open their browser's developer tools, inspect network requests, and extract the analytics key.

Because of this inherent visibility, public browser keys must be heavily constrained by the analytics provider. They are designed for client-side tracking: capturing page views, active sessions, and explicitly named product events (like `signup.completed`), as well as routing browser-side logs. They are fundamentally incapable of altering backend operational data.

To mitigate the risk of abuse, robust analytics systems apply several layers of security to public keys:

1.  **Origin Allowlists:** This is the most critical defense mechanism. A public key is bound to a specific set of allowed domains (Origins). If a malicious actor extracts your key and attempts to send data from their own server or a different website, the analytics ingress will reject the payload because the HTTP `Origin` header does not match the allowlist. While origin headers can theoretically be spoofed by custom scripts, this constraint effectively blocks ordinary browsers from being used for cross-site abuse, which is the primary vector for spam.
2.  **Rate Limiting and Quotas:** Because public endpoints are open to the internet, they must have strict limits. For instance, a system might limit each key to a specific number of event or heartbeat units per minute (e.g., 6,000 units/minute). This prevents a compromised key from being used to flood the analytics database or incur massive ingestion costs via a denial-of-service attack.
3.  **Aggregate and Bounded Storage:** Client-side telemetry often focuses on aggregates rather than raw, unbounded streams. Individual visitor IDs might be hashed and anonymized, and the retention of raw event data is typically bounded to prevent infinite storage growth from uncontrolled client spikes. In our systems, pending batches and stage sizes are explicitly bounded to maintain predictable resource consumption.
4.  **Revocability:** Public keys are designed to be disposable. If a key is actively abused or leaked beyond its intended scope, it can be revoked and replaced instantly without affecting backend telemetry or requiring server redeployments. A compromised browser key is a nuisance, not a catastrophe.

In short, a public browser key is "public" not because you want to share it, but because you assume it *will* be seen. Its security relies entirely on the boundaries enforced by the receiving server, ensuring that even a leaked key has a strictly limited blast radius.

## The Role of Private Server Keys

Backend services—whether they are Node.js Express applications, Go microservices, or Cloudflare Workers—operate in trusted environments. Code and environment variables running on these servers are hidden from the end user.

Because the environment is trusted, the credentials used by backend SDKs are **private server keys**. These keys are fundamentally different from their browser counterparts in both capability and consequence:

1.  **Unconstrained Access:** Private keys do not have origin restrictions. A backend service might not even have a standard HTTP Origin header to evaluate. They are authorized to submit highly sensitive backend health data, such as complete endpoint telemetry (method, route, status, duration, response size), OpenTelemetry (OTLP) traces, and detailed, structured server logs.
2.  **Strict Secrecy:** If a private server key is leaked, the consequences are severe. An attacker could inject fabricated endpoint latency, flood your logs with false errors, or otherwise poison the internal view of your application's health. Therefore, these keys must be securely managed via environment variables or secret managers (like Infisical or Cloudflare Secrets) and never committed to source control or sent to a client device.
3.  **Scope Verification:** When a backend SDK sends a batch of telemetry, the ingress service verifies the private key against the configured project and environment. This ensures that the server is authenticated to write to that specific namespace, and that the data is trusted implicitly.

By keeping server keys strictly private, you guarantee that your core operational metrics—the health of your APIs, your error rates, and your backend logs—remain trustworthy and free from client-side manipulation. This trust allows you to build alerting and operational dashboards without worrying that a clever user might trigger a false pager alarm.

## The App Health Approach: Projects, Environments, and Scoped Keys

Effective telemetry management also requires isolating data between different stages of the development lifecycle. Mixing staging traffic with production analytics ruins the accuracy of your reports and can trigger false alerts.

Systems like App Health solve this by nesting credentials within **Projects** and **Environments**.

*   **Projects:** A logical grouping of your application (e.g., "Marketing Site" or "E-commerce API").
*   **Environments:** Within a project, you can define up to 20 environments (e.g., "production", "staging", "development").

Each environment issues its own distinct set of credentials: one environment-scoped private key for servers, and origin-bound public keys for browsers. This means your `staging` database receives endpoint health from your staging servers and web analytics from your staging URLs, completely isolated from `production`.

Furthermore, modern systems treat telemetry features as **independent capabilities**. Web analytics, endpoint monitoring, and logging are adopted independently within an environment. Disabling web analytics in staging does not revoke the private key or discard incoming server logs; it merely updates the capability state. This granular control allows teams to roll out instrumentation incrementally.

For legacy systems that previously relied on product-wide keys, the migration to environment-scoped keys provides a clear path forward without immediately breaking older clients. Legacy product keys can retain their pre-existing behavior, while new environments strictly enforce the scoped isolation.

## Concrete Examples: Integration in Practice

Let's look at how this division translates into actual code integration. Notice how the frontend relies on origin validation, while the backend relies on injected secrets.

### Frontend: Public Browser Key Integration

On the frontend, you initialize a lightweight tracking script. Notice how the script tag explicitly requires the `data-key` (the public browser key) and binds it to a project. The analytics ingestion endpoint uses the browser's implicit `Origin` header to validate the request against the key's allowlist.

```html
<!-- Example of a Public Browser Key integration -->
<script
  defer
  src="https://health.example.com/tracker.js"
  data-key="pk_browser_12345abcde"
  data-project="proj_98765xyz"
  data-identity="persistent"
  data-endpoint="https://ingest.example.com/v1/browser"
></script>
```

Once loaded, developers can send explicitly named events without needing any further authentication, as the context is established by the public key. This keeps the instrumentation fast and dependency-free.

```javascript
// Sending a named product event from the client
window.appHealth.track('signup.completed');
```

### Backend: Private Server Key Integration

On the server side, integration looks entirely different. The credential is never hardcoded. Instead, the Node.js (or Go) SDK is initialized using an environment variable containing the private server key.

```javascript
// Example of a Private Server Key integration (Node.js/Express)
import express from 'express';
import { AppHealth } from '@saas-maker/app-health';
import { appHealthMiddleware } from '@saas-maker/app-health/express';

const app = express();

// Initialize the backend SDK using a secure environment variable
const health = new AppHealth({
  ingestEndpoint: 'https://ingest.example.com',
  privateKey: process.env.APP_HEALTH_PRIVATE_KEY, // Never expose this to the client
  environment: 'production'
});

// The middleware automatically captures endpoint health (latency, errors)
app.use(appHealthMiddleware(health));

app.post('/api/orders', (req, res) => {
  // Business logic here
  res.status(200).send({ success: true });
});

app.listen(3000);
```

In this backend scenario, the SDK securely batches endpoint telemetry and transmits it using the private key. The ingress API verifies the key's signature and environment scope before accepting the data. The SDK handles retries, overflow protection, and batching transparently, ensuring that performance is not degraded by telemetry collection.

## Internal Link Suggestions

*   *[Link suggestion: "analytics identity" or "visitor recognition" guide]* - When discussing persistent anonymous visitors in the "Nature of Public Browser Keys" section.
*   *[Link suggestion: "project environments" documentation]* - When introducing the concept of Projects and Environments.
*   *[Link suggestion: "structured logging" guide]* - When mentioning explicit browser logs and server logs.

## Next Actions

Maintaining the boundary between client and server telemetry is critical for data accuracy and system security. Take a moment to audit your current analytics integrations:

1.  **Check your frontend code:** Are you accidentally exposing a powerful, multi-purpose API key in your client-side JavaScript? Ensure only origin-bound, public keys are present in the browser.
2.  **Review your environments:** Are your staging and production metrics mingled? Transition to environment-scoped keys to isolate your reporting.
3.  **Audit your server configuration:** Confirm that private server keys are securely stored in a secret manager and injected at runtime, completely isolated from public repositories.

By strictly separating public browser keys from private server keys, you ensure that your web analytics remain frictionless for the frontend, while your critical backend telemetry remains locked down and trustworthy.

---

## Source notes

*   **Public Browser Keys & Constraints:** Supported by `docs/browser-analytics.md` (Origin checks constrain ordinary browsers; public keys are bound to project, environment, and allowed Origin, and are revocable. `POST /v1/browser` checks origins and limits each key to 6,000 event/heartbeat units per minute).
*   **Private Server Keys & Endpoint Telemetry:** Supported by `docs/project-environments.md` (Private server keys accept endpoint telemetry and explicit server logs only for that environment. Browser and native distributed clients must never contain private server credentials).
*   **Projects, Environments, and Capabilities:** Supported by `docs/project-environments.md` (App Health has one workspace of projects. Each project can have up to 20 environments. Web analytics, Endpoint health, and Logs are independently adopted within each environment).
*   **Concrete Examples:** Derived from `docs/browser-analytics.md` snippet for the HTML script tracker, and conceptualized from Node SDK capabilities described in `PROJECT_STATUS.md` and `PRODUCT.md` (Node 20+ with Express, bounded fail-open delivery, environment-scoped private keys).
*   **Limitation:** Note that while the architectural principles are sound, the actual *browser analytics* capability in App Health is currently marked as "local and unreleased" for production, per `docs/browser-analytics.md` and `PROJECT_STATUS.md`. The production dashboard leads with web analytics, but the full Cloudflare provisioning for browser events remains pending (Issue #58). Endpoint health and server logging are fully deployed.
