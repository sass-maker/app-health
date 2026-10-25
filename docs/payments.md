# Explicit payments and recorded revenue

This is the custom-provider foundation of [#219](https://github.com/sass-maker/app-health/issues/219).
It is implemented locally; production migration/release, provider connections,
webhook delivery and historical imports are not established by these examples.

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

Raw-body validators for Stripe and Standard Webhooks (Dodo/Polar, including
explicit Polar legacy-secret encoding) are tested primitives. They do not create
provider connections, expose webhook routes or import history. Those workflows
remain open in #219.
