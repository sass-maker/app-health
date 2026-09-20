---
title: 'How to distinguish a real outage from missing telemetry'
slug: 'how-to-distinguish-a-real-outage-from-missing-telemetry'
target_query: 'distinguish outage from missing telemetry'
search_intent: 'Informational - Engineers and product teams diagnosing whether a drop in dashboard metrics indicates a true system failure or an instrumentation issue.'
meta_title: 'How to Distinguish a Real Outage from Missing Telemetry'
meta_description: 'When your dashboard shows zero traffic, is your application down, or did your telemetry break? Learn to tell the difference and diagnose the root cause.'
---

## Outline

1.  **Introduction**: The panic of a flatlining dashboard and the critical distinction between a downed service and a silent telemetry agent.
2.  **Symptoms of a True Outage**: Identifying genuine downtime through edge proxy errors and external user reports.
3.  **Symptoms of Missing Telemetry**: Spotting telemetry failures when the underlying application remains entirely healthy.
4.  **Concrete Diagnostic Examples**: Walkthroughs of a silent egress failure and a process crash masking as missing data.
5.  **Designing for Observability Resilience**: How bounded, fail-open telemetry delivery keeps your application running even when backends struggle.
6.  **Practical Next Action**: Steps to verify telemetry failure modes and ensure independent monitoring signals.
7.  **Source Notes (Internal)**: Repository evidence supporting claims.

## Introduction

It is a uniquely stressful moment for any product team: you open your monitoring dashboard, and incoming requests have suddenly plunged to zero. The application appears to be processing no background jobs and serving no customers. The immediate question is always the same: is the application actually down, or did the telemetry system just stop reporting?

Distinguishing a real outage from missing telemetry is a critical diagnostic skill. When an application is down, every second counts towards customer trust. Incident response teams need to focus on rolling back deployments, scaling resources, or failing over. However, if the application is perfectly healthy and only the metrics-gathering mechanism has failed, waking up the entire engineering organization for a critical incident is a fast track to alert fatigue.

Relying on a single pane of glass can be dangerous if you do not understand the failure modes of the glass itself. Instrumentation is software, and like all software, it can encounter network timeouts, configuration errors, and bugs. Modern systems compound this problem by relying on asynchronous agents and complex sampling rules to ship data to remote backends. When that pipeline breaks, the dashboard goes dark, but the customer experience might be completely uninterrupted.

To navigate these incidents, teams must look beyond the primary dashboard, cross-reference independent signals, and understand the architectural boundaries of their telemetry SDKs.

## Symptoms of a True Outage

When an application genuinely fails, the blast radius usually extends beyond the internal telemetry dashboard. True outages leave a trail of evidence across multiple layers of infrastructure.

**Edge Proxy and Load Balancer Errors**
If primary application servers are down, the infrastructure sitting in front of them will typically notice first. Load balancers, API gateways, and edge proxies will begin returning `502 Bad Gateway`, `503 Service Unavailable`, or `504 Gateway Timeout` errors. Because these components generate their own metrics independently of your application code, checking your edge routing layer is the most reliable way to confirm a total service failure.

**Cascading Failures in Dependent Services**
In a microservices architecture, an outage in one service quickly becomes a timeout in another. If the primary API is down, you will see elevated error rates in frontend web servers or background workers that depend on it. If your dashboard shows zero traffic for the `Orders` service, but `Checkout` is logging connection timeouts attempting to reach `Orders`, you are looking at a real outage.

## Symptoms of Missing Telemetry

Conversely, missing telemetry has a different signature. The most glaring symptom is a complete disconnect between the empty metrics dashboard and the reality of the application's environment.

**The Application is Manually Accessible**
The simplest test is often the most effective. If the dashboard claims the service is receiving zero requests, but you can manually navigate to the web application and successfully interact with the API, your telemetry is failing. The service is up, but data is not reaching the visualization layer.

**Independent Logs Continue to Stream**
Application logs and endpoint telemetry are often processed by different systems. If your metrics graph has flatlined, but you can see a steady stream of explicitly authored structured logs (such as `user.login` events) flowing into your log aggregation tool, the application is actively serving traffic.

**Common Causes: Configuration and Egress**
Why does this happen? Often, a new deployment includes a misconfigured environment variable or an expired ingest API key. The application boots successfully but fails to authenticate its telemetry payloads. Alternatively, if a recent infrastructure change modified egress firewall rules without whitelisting the observability provider's domain, telemetry will be blocked. The application will attempt to send batches of metrics, but those requests will time out.

## Concrete Diagnostic Examples

To illustrate these concepts, let us examine two scenarios.

**Example A: The Silent Egress Failure**
Consider a Node.js API processing user profiles. After a routine security update, the infrastructure team tightens egress rules on the production cluster. The application continues to serve traffic normally, but the telemetry exporter running inside the application cannot reach its remote ingest endpoint.

On the dashboard, requests per minute drop sharply to zero. An engineer assumes the API is down. However, a quick check of edge metrics shows a steady stream of `200 OK` responses. A look at application logs reveals background jobs completing successfully. The API is healthy. By inspecting the application's standard error stream, they find repeated `ETIMEDOUT` errors originating from the telemetry SDK attempting to post data. The diagnosis is confirmed: missing telemetry, not a real outage.

**Example B: The Application Crash and Lost Batches**
In a different scenario, a Go-based order service receives a malformed payload that triggers an unhandled panic. The application crashes instantly.

Because the telemetry SDK batches requests asynchronously every few seconds, metrics for the requests that caused the crash are lost when the process dies. The dashboard shows a sudden drop in traffic, but no explicit `500 Internal Server Error` metrics are recorded because the batch was never flushed.

An engineer might assume telemetry just stopped. However, external synthetic checks begin failing immediately, and the container orchestrator reports that the pod is in a `CrashLoopBackOff` state. Here, missing telemetry was a symptom of a catastrophic crash.

## Designing for Observability Resilience

The relationship between an application and its observability tools must be managed to prevent one from bringing down the other.

**Bounded, Fail-Open Delivery**
Instrumentation must never break the instrumented application. If the observability backend goes down, the application must continue serving customers. Telemetry SDKs should employ bounded, fail-open delivery mechanisms. They must utilize strict timeouts, finite retry logic, and bounded memory buffers. If the buffer fills up because the ingest endpoint is unreachable, the SDK must drop telemetry data rather than consuming infinite memory and crashing the application.

**Deterministic Health States**
Dashboards should communicate uncertainty clearly. If an observability backend has not received data from a previously active endpoint, it should not automatically plot a zero, implying a confirmed lack of traffic. Instead, it should indicate a deterministic state, such as `insufficient-data`, acknowledging the state is unknown. Maintaining a normalized inventory of observed endpoints ensures that even if sampling drops metrics for a rare route, the dashboard shows metrics as unavailable rather than pretending the route was never called.

**Separation of Metrics and Explicit Logs**
Relying entirely on derived metrics can obscure the true state of the application. Distinguishing between endpoint telemetry (method, normalized route, status, duration) and explicit application logs (owner-authored events like `payment.failed`) provides a powerful diagnostic dual-signal. If endpoint telemetry drops due to a configuration error, but explicitly authored business logs continue flowing into a separate ingest pipeline, operators have immediate confirmation that the application is alive.

## Practical Next Action

To prepare for the moment the dashboard goes dark, take these practical steps:

1.  **Establish Independent Verification:** Ensure you have at least one monitoring signal operating outside your primary application codebase, such as edge proxy metrics or external synthetic pings.
2.  **Audit SDK Failure Modes:** Review the configuration of your telemetry SDKs. Verify they are configured to fail open, use bounded buffers, and enforce strict network timeouts. Ensure a slow observability backend cannot consume your application's connection pool.

_(Internal link suggestion: Link to your internal guide on "Setting up bounded retries in the Node SDK" or "Understanding the differences between Endpoint Telemetry and Application Logs in App Health".)_

If you are looking for an observability solution that enforces these principles by default, explore how App Health combines resilient endpoint telemetry with explicit application logs in a unified workspace, ensuring you always know exactly what is happening in your environment.

---

## Source Notes

_This section is for internal review only and should be removed before publication._

**Evidence & Claims Justification:**

- **Bounded, Fail-Open Delivery:** Supported by `PRODUCT.md` and `PROJECT_STATUS.md`. The repository emphasizes keeping "integration small and failure isolated from the instrumented application." The Node and Go SDKs explicitly document "bounded fail-open delivery with privacy, outage, retry, overflow, shutdown... coverage."
- **Separation of Metrics and Explicit Logs:** Supported by `README.md` and `PRODUCT.md`. App Health deliberately separates endpoint telemetry (method, route, status, duration) from explicit, owner-authored application logs, maintaining a strict privacy and functional boundary.
- **Normalized Inventory and Avoiding False Zeros:** Supported by `PROJECT_STATUS.md` and `README.md`. The Cloudflare production implementation uses a "privacy-bounded normalized D1 endpoint inventory and explicit sampled-metrics UI so every accepted endpoint remains visible without inventing zero values." Dashboards show `insufficient-data` states deterministically.
- **Batching and Crashes:** Supported by `README.md`. SDKs use asynchronous batching. The loss of in-memory batches during a crash is a real operational concern mitigated by graceful shutdown hooks (`await appHealth.close()`).

**Important Limitations to Keep in Mind:**

- App Health does **not** store full traces, spans, request bodies, headers, or query parameters. It projects only server spans into endpoint summaries. Do not imply that App Health offers deep trace exploration or session replay. (As noted in `PRODUCT.md`: "Keep advanced funnels, cohorts, revenue attribution, experiments, team management, and session replay out of scope.")
- The product does not currently support billing or team roles.
- SDK releases are currently explicit via GitHub Releases, not the public npm registry, as publisher authentication is unavailable.
