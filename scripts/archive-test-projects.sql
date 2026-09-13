-- Explicitly approved test projects only. Apply after migration 0013.
-- Idempotent; stops access before archiving. No telemetry or ownership is deleted.

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE keys SET revoked_at = unixepoch() * 1000
WHERE revoked_at IS NULL AND app_id IN (SELECT a.id FROM apps a JOIN targets t ON t.id = a.id AND t.name = a.name);

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE product_keys SET revoked_at = unixepoch() * 1000
WHERE revoked_at IS NULL AND app_id IN (SELECT a.id FROM apps a JOIN targets t ON t.id = a.id AND t.name = a.name);

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE public_log_keys SET revoked_at = unixepoch() * 1000
WHERE revoked_at IS NULL AND app_id IN (SELECT a.id FROM apps a JOIN targets t ON t.id = a.id AND t.name = a.name);

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE native_keys SET revoked_at = unixepoch() * 1000
WHERE revoked_at IS NULL AND app_id IN (SELECT a.id FROM apps a JOIN targets t ON t.id = a.id AND t.name = a.name);

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE analytics_shares SET revoked_at = unixepoch() * 1000
WHERE revoked_at IS NULL AND app_id IN (SELECT a.id FROM apps a JOIN targets t ON t.id = a.id AND t.name = a.name);

WITH targets(id, name) AS (VALUES
  ('app-bcd08baa-ffca-4241-827a-3908dee661f2', 'App Health canary'),
  ('app-9b4b0c5d-7524-4c33-9ec5-9e61c0f26ddf', 'App Health Demo'),
  ('app-9e114946-90fb-4810-be33-dae4eb6295bf', 'synthetic-production-canary-20260911-0e8606'),
  ('app-c2bfb68b-1fd4-4a1f-bfae-ba27244acede', 'synthetic-production-canary-20260911-85e0b5'),
  ('app-ce5537f6-3b1d-4933-a104-f4c97842c3fd', 'synthetic-production-canary-20260911-49ede0'),
  ('app-665880d9-287d-4a00-afcb-f564e19f36ff', 'Cloudflare sample')
)
UPDATE apps SET archived_at = unixepoch() * 1000
WHERE archived_at IS NULL AND EXISTS (SELECT 1 FROM targets t WHERE t.id = apps.id AND t.name = apps.name);
