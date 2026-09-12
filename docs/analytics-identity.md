# Visitor recognition and acquisition

Implementation tracked in [#58](https://github.com/sass-maker/app-health/issues/58).
These changes are local and unreleased.

New tracker installations default to persistent anonymous browser recognition.
The installation snippet includes `data-project` so rotating a public key does
not reset identity. `data-identity="session"` opts out of persistent visitors.
This is an integration setting in the installed script, not a remote dashboard
policy; changing it requires updating that script attribute.

Persistent visitor IDs expire after 90 days. A visit expires after 30 minutes
without meaningful activity; idle heartbeats do not extend it or create pageviews.
Same-origin tabs share persistent visitor and visit state. Different browsers,
devices, origins, and projects are not automatically linked. Clearing or blocking
storage reduces recognition. Session-only and older SDK payloads omit visitor
identity; reports show their sessions as unidentified rather than new visitors.

The collector hashes random IDs with project/environment scope before queueing.
It stores bounded UTM source, medium, campaign, content, term, a sanitized entry
path, and coarse browser/device/country categories. Country comes from trusted
Cloudflare request metadata, not client-supplied headers. Raw IP and user agent
strings are not archived. Integrators must keep personal data out of campaign
names and explicit event names.

Reports support 1 hour, 24 hours, 7 days, and 30 days, with equal-length previous
periods. Distinct counts cover the whole interval; daily uniques are never added
together. Sampling can undercount distinct visitors and sessions. Dimension
counts describe pageviews (or occurrences when filtering an event), not people.
Only the selected group of dimensions is queried, using the existing scoped
60-second cache. Public links retain their explicit limited disclosure contract.

## Delivery and cost boundaries

Browser queue acknowledgement follows durable staging of archive and analytical
projection work. Failed projections retry with backoff independently of R2
archival. Both pending queues have capacity limits. R2 objects remain batched and
compressed; an early projection alarm must not force a small archive object.
A crash after an Analytics Engine append but before marking completion can still
cause a duplicate. This is not an exactly-once projection guarantee.

Cloudflare supports a restricted SQL dialect. Queries use its documented
[conditional functions](https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/conditional-functions/)
and aggregate functions, with matching branch types and empty-identity exclusion.

## Research provenance

This is an original implementation informed by published behavior and source
review. No third-party source was copied into the tracker or backend.

- [Umami tracker, MIT](https://github.com/umami-software/umami/blob/ca661c7057984aa98ed4f7083d84dae2f65bfcb0/src/tracker/index.ts): guarded browser storage and explicit identification boundaries.
- [Plausible, AGPL-3.0](https://github.com/plausible/analytics/tree/5716baab58b7faf62d721453ed9880de18e48ede): session expiry, attribution allowlists and separation of bot filtering. Server code was not copied or adapted.
- [Fathom Lite, MIT](https://github.com/usefathom/fathom/tree/2d895d8299d31c9957c806aa24720271668f3f09): bounded visit state and bot/preview distinctions.
- [DataFast UTM documentation](https://datafa.st/docs/utm-tracking): simple campaign dimensions.

Highsignal currently emits coarse server-side `traffic.summary` logs separating
verified bots, declared bots, automation and unknown requests. These are separate
from JavaScript visitor counts. A dedicated bot report and portable server bot
integration remain separate work; unknown requests must not be labelled human.
