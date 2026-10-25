-- Exact, explicit financial facts. No browser clickstreams or customer identity.
-- Namespace includes app/environment/provider/account/test-or-live throughout.
CREATE TABLE IF NOT EXISTS payment_facts (
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('custom', 'stripe', 'polar', 'dodo')),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund')),
  fact_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor BETWEEN 0 AND 1000000000000),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  source TEXT,
  page TEXT,
  country TEXT,
  campaign TEXT,
  fact_hash TEXT NOT NULL CHECK (length(fact_hash) = 64),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, environment_id, provider, account_id, mode, kind, fact_id),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id),
  CHECK ((kind = 'payment' AND fact_id = transaction_id) OR
    (kind = 'refund' AND amount_minor > 0 AND source IS NULL AND page IS NULL AND country IS NULL AND campaign IS NULL))
);
CREATE INDEX IF NOT EXISTS payment_facts_period ON payment_facts (app_id, environment_id, occurred_at);
CREATE INDEX IF NOT EXISTS payment_facts_original ON payment_facts (app_id, environment_id, provider, account_id, mode, transaction_id, kind);

CREATE TABLE IF NOT EXISTS payment_deliveries (
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, environment_id, provider, account_id, mode, delivery_id),
  FOREIGN KEY (environment_id, app_id) REFERENCES environments (id, app_id)
);

CREATE TRIGGER IF NOT EXISTS payment_facts_conflict BEFORE INSERT ON payment_facts
WHEN EXISTS (SELECT 1 FROM payment_facts f
  WHERE (f.app_id, f.environment_id, f.provider, f.account_id, f.mode, f.kind, f.fact_id) =
    (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, NEW.kind, NEW.fact_id)
    AND f.fact_hash != NEW.fact_hash)
BEGIN SELECT RAISE(ABORT, 'payment identity conflict'); END;

CREATE TRIGGER IF NOT EXISTS payment_deliveries_conflict BEFORE INSERT ON payment_deliveries
WHEN EXISTS (SELECT 1 FROM payment_deliveries d
  WHERE (d.app_id, d.environment_id, d.provider, d.account_id, d.mode, d.delivery_id) =
    (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, NEW.delivery_id)
    AND d.fact_hash != NEW.fact_hash)
BEGIN SELECT RAISE(ABORT, 'payment delivery conflict'); END;

-- Refunds may precede the original. Either arrival order must agree on currency
-- and cannot refund more than the recorded original; duplicate inserts add zero.
CREATE TRIGGER IF NOT EXISTS payment_refund_guard BEFORE INSERT ON payment_facts
WHEN NEW.kind = 'refund' AND NOT EXISTS (SELECT 1 FROM payment_facts f
  WHERE (f.app_id, f.environment_id, f.provider, f.account_id, f.mode, f.kind, f.fact_id) =
    (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, NEW.kind, NEW.fact_id))
AND EXISTS (SELECT 1 FROM payment_facts p
  WHERE (p.app_id, p.environment_id, p.provider, p.account_id, p.mode, p.kind, p.fact_id) =
    (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, 'payment', NEW.transaction_id)
  AND (p.currency != NEW.currency OR p.amount_minor < NEW.amount_minor +
    (SELECT COALESCE(SUM(r.amount_minor), 0) FROM payment_facts r
     WHERE (r.app_id, r.environment_id, r.provider, r.account_id, r.mode, r.kind, r.transaction_id) =
       (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, 'refund', NEW.transaction_id))))
BEGIN SELECT RAISE(ABORT, 'payment refund conflict'); END;

CREATE TRIGGER IF NOT EXISTS payment_original_guard BEFORE INSERT ON payment_facts
WHEN NEW.kind = 'payment' AND (
  EXISTS (SELECT 1 FROM payment_facts r
    WHERE (r.app_id, r.environment_id, r.provider, r.account_id, r.mode, r.kind, r.transaction_id) =
      (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, 'refund', NEW.transaction_id)
      AND r.currency != NEW.currency)
  OR NEW.amount_minor < (SELECT COALESCE(SUM(r.amount_minor), 0) FROM payment_facts r
    WHERE (r.app_id, r.environment_id, r.provider, r.account_id, r.mode, r.kind, r.transaction_id) =
      (NEW.app_id, NEW.environment_id, NEW.provider, NEW.account_id, NEW.mode, 'refund', NEW.transaction_id)))
BEGIN SELECT RAISE(ABORT, 'payment refund conflict'); END;

CREATE TRIGGER IF NOT EXISTS payment_facts_immutable BEFORE UPDATE ON payment_facts
BEGIN SELECT RAISE(ABORT, 'payment facts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS payment_deliveries_immutable BEFORE UPDATE ON payment_deliveries
BEGIN SELECT RAISE(ABORT, 'payment deliveries are immutable'); END;
