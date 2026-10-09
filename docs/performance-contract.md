# Fleet performance contract

This is the canonical home for Fleet's performance classes, telemetry schemas,
budgets, and sustained-alert rules. `@app-health/contracts` exports the typed
constants, Zod validators, and pure breach evaluator. This contract defines
behavior for future consumers; it does not emit telemetry or enforce routing.

## Classes and budgets

Choose a class for each monitored surface: `landing` for public entry pages,
`app` for interactive product pages, `api` for request handlers, and `job` for
background work. Web budgets apply at p75; server budgets measure handler time.

| Class        | Metric / operation  | Budget                                                    |
| ------------ | ------------------- | --------------------------------------------------------- |
| landing      | LCP / INP / TTFB    | p75: 2000 / 200 / 600 ms                                  |
| app          | LCP / INP / TTFB    | p75: 2500 / 200 / 800 ms                                  |
| landing, app | CLS                 | p75: 100 `cls_milli` (CLS × 1000, i.e. 0.1)               |
| api          | read                | p50: 150 ms; p95: 500 ms; p99: 1500 ms                    |
| api          | write               | p95: 800 ms                                               |
| job          | per-route operation | No default; document a budget per route before evaluating |

`serverBudgetFor(class, kind)` returns the API read/write budget, or `null` for
classes without a server default. Require at least 50 web-vital samples per
day per evaluated class/route group and metric; smaller sets are insufficient.

## API stage timing

Event: `api.stage_timing`; level: `debug`. This reuses the High Signal PR #232
shape: route, status, total duration, cache outcomes, colo, and named stage
durations in log props.

```json
{
  "event": "api.stage_timing",
  "level": "debug",
  "props": {
    "route": "/api/articles/:id",
    "status": 200,
    "total_ms": 120,
    "edge_cache": "MISS",
    "inner_cache": "HIT",
    "colo": "BOM",
    "cold": 0,
    "release": "v1.2.0",
    "db_ms": 40,
    "render_ms": 20
  }
}
```

`StageTimingProps` validates props; `parseStageTiming` returns `{ok:true,value}`
or `{ok:false,error}` with a Zod error.

- Required: `route`, integer `status` (100–599), `total_ms`, `edge_cache`,
  and `inner_cache`. Timings are finite numbers in 0–600000 ms.
- Route is a template starting with `/`, at most 120 characters, with no
  query, fragment, or whitespace. Digit-only, UUID, and hexadecimal segments
  of 16 or more characters are rejected; use placeholders such as `:id`.
- Both cache fields accept `HIT`, `MISS`, `EXPIRED`, `BYPASS`, `DYNAMIC`,
  `STALE`, `REVALIDATED`, or `NONE`.
- `colo` is 1–8 ASCII alphanumeric characters, defaulting to `unknown`.
  Optional `cold` is 0 or 1; optional `release` matches `[A-Za-z0-9._-]{1,64}`.
- Up to 20 additional stage keys match `^[a-z][a-z0-9_]{0,31}_ms$`, each with
  a finite value in 0–600000 ms. All other keys are errors.

## Web vitals

Event: `web.vitals`; level: `debug`. `WebVitalsProps` requires `route_group`
and `nav_type`, plus at least one metric:

```json
{
  "route_group": "/articles",
  "nav_type": "navigate",
  "lcp_ms": 1800,
  "inp_ms": 150,
  "ttfb_ms": 500,
  "cls_milli": 20
}
```

`route_group` matches `^/[a-z0-9_-]{0,40}$`: root, a first path segment, or a
product-supplied template label. It rejects concrete IDs by the same segment
rules as stage timing. Navigation types are `navigate`, `reload`,
`back_forward`, `prerender`, and `restore`. Optional LCP, INP, and TTFB are
finite numbers in 0–600000 ms; optional `cls_milli` is an integer in 0–10000.
Zero is a present metric. Unknown fields are rejected.

## Sustained alerts

- Evaluate oldest-to-newest 15-minute windows, each containing a sample count
  and the measured percentile. A window needs at least 30 samples.
- A sufficient window breaches only when its value is greater than the budget.
  At least 3 of the last 4 windows must breach to enter `breach`; one spike
  never creates an incident. Insufficient windows count as neither breach nor clean.
- Stay in `breach` until the last 4 windows are all sufficient and clean.
  Four clean windows also establish `ok` when no prior state exists.
- Otherwise keep the prior state, or return `insufficient` if none exists.
  If none of the last 4 windows is sufficient, the result is `insufficient`
  (unless already in `breach`): missing data never establishes or preserves `ok`.
- Synthetic probes require 3 consecutive failures, separately from percentile
  windows; the pure percentile evaluator does not evaluate probe failures.
- Debug/info performance telemetry never reaches Slack. Only sustained breaches
  create in-app `warn` incidents; consumers must enforce this routing policy.

## Privacy and sampling

Use owner-supplied templates, never raw request URLs. Do not collect IDs,
query values, request/response bodies, user content, identity, headers, cookies,
credentials, stacks, or spans. ID detection is a guardrail; applications must
also normalize slugs and any other identifying values before validation.

Keep sampling bounded and unbiased within each class/route group, navigation
type, and metric. Record actual sampled counts; do not inflate them to meet
the 50-per-day or 30-per-window minimums. Low-volume surfaces remain
insufficient and can use separately configured synthetic probes. Do not
merge different route budgets or percentiles into one alert window.

## Speed report

`GET /v1/reports/speed` requires a workspace owner session; product keys are
forbidden. Query parameters: `range=1h|24h|7d` (default `24h`), optional `app_id`,
and `class=landing|app|api` (default `app`). Web budgets follow the selected
class (`api` has no web budget); server timings always use API read budgets.

The report scopes production environments to primary/active, non-archived catalog
products in the owner's workspace, capped at 56 products and 25 routes per product and
event (breaching routes first, then busiest). After a catalog lookup, two indexed D1 reads select at most
20,000 newest debug logs each for `api.stage_timing` and `web.vitals` within
the requested range. Stage timings are read only from `server` logs and web vitals
only from `browser` logs, so a browser public key cannot forge server timings. Hitting either limit marks that event's `truncated` flag
on every product, including products with no retained samples. Internal results
are cached for 60 seconds; owner responses use `no-store`.

Percentiles use nearest rank over observed rows. Product-emitted stage logs
are sampled; these counts and error rates describe samples, not total traffic.
Invalid props count as rejected and are excluded. Web breaches require 50
samples of that metric per route group; server breaches require 30 per route.
Smaller sets can show percentiles but never breaches. Sustained state uses
the four consecutive 15-minute windows ending at generation time, evaluating
server p95 and LCP p75 only, with no persisted previous state. Cache counts
use `edge_cache`; hit ratio is `HIT / (samples - NONE)`, or null when all are
`NONE`. A product is measured when any route/metric meets its sample minimum,
insufficient when only smaller valid sets exist, and no_data when none exist.
The summary counts a product as breaching for any percentile or sustained breach.
No raw props leave the report.

## Not implemented yet

Opt-in browser tracker emission is implemented: one debug-level `web.vitals`
log per document goes to the existing browser Logs endpoint. Add `data-vitals`
to the tracker tag; the tracker lazily loads `/vitals.js` from the same host.
Vitals are a separate opt-in static file; only the loader (about 180 bytes)
raises the tracker gzip budget, from 3250 to 3400 bytes. See
[browser analytics](browser-analytics.md#web-vitals) for attributes and sampling.
The owner speed report API above reads both event types. Dashboard speed views,
a daily-report speed section, per-product wiring, runtime alert routing, probe
evaluation, and per-job route budgets remain unimplemented.
