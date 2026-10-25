# Explicit payments and recorded revenue

This is the payment/revenue integration in [#219](https://github.com/sass-maker/app-health/issues/219).
Custom facts and Stripe/Polar/Dodo connection, webhook and bounded import flows
are implemented. These examples and local provider fixtures do not establish
production account activation, webhook delivery or historical completeness.

Send explicit financial facts from a trusted server to `POST /v1/payments` on
the ingest host, using an active private project/environment key as Bearer auth.
Browser Origins are rejected. A public browser key cannot record payments.
The request is capped at 16 KiB; project/environment ownership is resolved from
the private key and checked against the environment.

```json
{
  "schema_version": 1,
  "app_id": "YOUR_APP_ID",
  "environment_id": "YOUR_ENVIRONMENT_ID",
  "namespace": { "provider": "custom", "account_id": "merchant", "mode": "live" },
  "delivery_id": "delivery-unique-id",
  "fact": {
    "kind": "payment",
    "transaction_id": "payment-unique-id",
    "occurred_at": 1792886400000,
    "amount_minor": 2900,
    "currency": "USD",
    "attribution": { "source": "newsletter", "page": "/pricing", "campaign": "launch" }
  }
}
```

`occurred_at` is Unix milliseconds. Amounts are integer currency minor units,
not floating-point major units: 2900 USD is $29.00; 2900 JPY is ¥2,900. Unknown
currency codes display raw minor units instead of assuming a decimal exponent.
Amounts are bounded to 1e12 per fact, and unsafe aggregate integers reject the
report. Facts more than five minutes in the future are rejected.

For a refund, use `kind: "refund"`, the original `transaction_id`, a distinct
`refund_id`, its own occurrence timestamp and positive `amount_minor`. Omit
attribution: refunds inherit the original payment’s attribution. Multiple partial
refunds are distinct facts. A refund can precede its payment; it remains pending
and excluded from net until the original arrives. Currency mismatch or refunds
exceeding the original reject atomically in either arrival order.

Retry the same delivery ID and identical fact after a lost acknowledgment.
A second delivery ID for the same canonical payment/refund also deduplicates.
Reusing either identity with changed facts returns 409. A 202 means the canonical
fact and delivery receipt committed; it does not prove provider-account completeness.
Scope includes app, environment, provider, account and live/test mode. Generic
ingestion permits only `provider: "custom"`; it cannot impersonate a connected provider.

Authenticated owners query `GET /v1/analytics/revenue` with `app_id`,
`environment_id`, `from`, `to`, and optional `mode`, `currency`, `provider`,
`account_id` and `breakdown=source|page|country|campaign`. The half-open period
is `[from,to)`, at most 366 days. Payments and refunds use their own occurrence
times, including refunds whose originals lie outside the period. Reports keep
currency/account/mode namespaces separate. Output caps are 200 totals and 500
dimension groups; excessive or unsafe results fail without silent truncation.

The Events dashboard uses its selected rolling period and a separate payment-mode
selector. Traffic/event filters do not alter financial facts. Average payment is
gross payments divided by payment count, rounded to the nearest currency minor
unit. Attribution coverage means any explicit source/page/country/campaign is
present; it is not verified identity or source completeness. Fees, taxes and FX
conversion are not inferred.

Migration `0031_payment_ledger.sql` adds immutable D1 financial facts and delivery
receipts, with conflict/refund guards in the same transaction. Local development
uses a bounded in-memory ledger and clears on restart. Production never falls
back to local storage. Financial growth and query-scan cost still scale with
traffic; this slice is not a production load/cost qualification.

Connected providers use `GET /v1/analytics/provider-revenue` with the same scoped
query fields. Its `provider_object_created` basis and coverage note describe
provider creation dates and supported resources; do not interpret this as a
per-capture cashflow history. The custom endpoint above excludes provider facts.
Provider connections, product routing, resumable imports and reconciliation are
available in Settings. Credentials use a dedicated versioned encryption keyring;
account-specific configuration and production Queue delivery require activation.

The scoped MCP `revenue_report` tool defaults to custom recorded cashflows.
Use `basis: "provider"` for connected-provider revenue, optionally filtering
`provider: "stripe"`, `"polar"` or `"dodo"`. Specifying one of those providers
also selects the provider basis. Conflicting basis/provider arguments reject;
currencies, accounts and live/test modes remain separate.
