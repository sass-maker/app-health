-- Provider operational state contains no customer payloads or plaintext credentials.
CREATE TABLE IF NOT EXISTS payment_connections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('stripe','polar','dodo')),
  account_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('live','test')), selector TEXT,
  generation INTEGER NOT NULL CHECK(generation > 0), status TEXT NOT NULL CHECK(status IN ('active','disconnected')),
  routing TEXT NOT NULL CHECK(routing IN ('exclusive','products')), cipher TEXT,
  created_at INTEGER NOT NULL, verified_at INTEGER NOT NULL, webhook_at INTEGER,
  UNIQUE(provider,account_id,mode),
  FOREIGN KEY(environment_id,app_id) REFERENCES environments(id,app_id)
);
CREATE TABLE IF NOT EXISTS payment_routing_rules (
  connection_id TEXT NOT NULL REFERENCES payment_connections(id), product_id TEXT NOT NULL,
  app_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  PRIMARY KEY(connection_id,product_id),
  FOREIGN KEY(environment_id,app_id) REFERENCES environments(id,app_id)
);
CREATE TABLE IF NOT EXISTS payment_assignments (
  connection_id TEXT NOT NULL REFERENCES payment_connections(id), transaction_id TEXT NOT NULL,
  app_id TEXT NOT NULL, environment_id TEXT NOT NULL, assigned_at INTEGER NOT NULL,
  PRIMARY KEY(connection_id,transaction_id),
  FOREIGN KEY(environment_id,app_id) REFERENCES environments(id,app_id)
);
CREATE TRIGGER IF NOT EXISTS payment_assignment_immutable BEFORE UPDATE ON payment_assignments
BEGIN SELECT RAISE(ABORT,'payment assignment immutable'); END;
CREATE TRIGGER IF NOT EXISTS payment_connection_scope_immutable BEFORE UPDATE ON payment_connections
WHEN (NEW.id,NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.provider,NEW.account_id,NEW.mode,COALESCE(NEW.selector,'')) !=
 (OLD.id,OLD.workspace_id,OLD.app_id,OLD.environment_id,OLD.provider,OLD.account_id,OLD.mode,COALESCE(OLD.selector,''))
BEGIN SELECT RAISE(ABORT,'payment connection scope immutable'); END;
CREATE TABLE IF NOT EXISTS payment_provider_objects (
  connection_id TEXT NOT NULL REFERENCES payment_connections(id), kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
  resource_id TEXT NOT NULL, transaction_id TEXT NOT NULL, resource_created_at INTEGER NOT NULL, currency TEXT, reason TEXT,
  source TEXT, page TEXT, country TEXT, campaign TEXT,
  attribution_provenance TEXT NOT NULL DEFAULT 'provider_resource_metadata', observed_at INTEGER NOT NULL,
  PRIMARY KEY(connection_id,kind,resource_id)
);
CREATE TABLE IF NOT EXISTS payment_provider_jobs (
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES payment_connections(id), generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('import','webhook','reconcile')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','paused','finished','cancelled')),
  phase TEXT NOT NULL CHECK(phase IN ('payments','refunds','resource','done')),
  from_time INTEGER NOT NULL, to_time INTEGER NOT NULL, cursor TEXT NOT NULL DEFAULT '{}',
  resource_kind TEXT, resource_id TEXT, delivery_id TEXT, body_digest TEXT,
  processed INTEGER NOT NULL DEFAULT 0, recorded INTEGER NOT NULL DEFAULT 0, unresolved INTEGER NOT NULL DEFAULT 0, filtered INTEGER NOT NULL DEFAULT 0,
  reason TEXT, retry_at INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(connection_id,delivery_id)
);
CREATE INDEX IF NOT EXISTS payment_jobs_due ON payment_provider_jobs(status,retry_at,lease_until);
CREATE TRIGGER IF NOT EXISTS payment_webhook_identity BEFORE INSERT ON payment_provider_jobs
WHEN NEW.delivery_id IS NOT NULL AND EXISTS(SELECT 1 FROM payment_provider_jobs j WHERE
 j.connection_id=NEW.connection_id AND j.delivery_id=NEW.delivery_id AND j.body_digest!=NEW.body_digest)
BEGIN SELECT RAISE(ABORT,'payment webhook identity conflict'); END;
