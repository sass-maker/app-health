# Test project cleanup

The owner approved removing all sample/demo/canary projects. Production inventory identified six exact ID/name pairs in `scripts/archive-test-projects.sql`. Real Fleet projects are excluded. No fuzzy name matching runs in production.

## Release sequence

1. Apply additive D1 migration `0013_archive_projects.sql` before deploying the Worker that reads `apps.archived_at`.
2. Release the Worker and dashboard changes together.
3. Execute `scripts/archive-test-projects.sql` against the production D1 database. It revokes endpoint/product, browser, native keys and public share links before marking the six projects archived. Each statement is idempotent; if interrupted, rerun the file. Do not claim completion until every statement succeeds.
4. Verify six archived rows, zero active keys/shares for those rows, and unchanged real-project IDs and ownership. Check signed-in project lists and totals.

Archiving preserves project metadata, ownership, environments, and telemetry. Existing storage retention policies still apply. Restoring a project requires clearing its archive timestamp and issuing fresh keys/links; old revoked credentials stay revoked.

Archive state filters account permissions and all inventory modes. Historical workspace summaries and reports use the current active project set; cache keys for reports include this set. Live dashboard totals intersect the active inventory, including frames received from a pre-existing presence stream.

## Attribution and loading

Source normalization now shares one hostname/alias registry between collection and historical report SQL, including social short links, Hacker News, Product Hunt, regional Google domains and AI assistants. Unknown referrers are not guessed. Expanded labels apply to historical source rows; previously stored channel values are not rewritten.

Recent reports are reused in dashboard memory for one minute (at most 12 entries), scoped by owner, project, environment, date range and filters. Sign-out unmounts the cache. Explicit refresh bypasses it. Live connections start independently of historical summary queries, and summary/presence reads run concurrently. These remove avoidable waits but do not establish a production cold-load latency benchmark.
