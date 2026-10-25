-- Unparseable resources retain only verified identity and a safe reason, never fabricated financial time.
CREATE TABLE payment_provider_issues (
 connection_id TEXT NOT NULL REFERENCES payment_connections(id), kind TEXT NOT NULL CHECK(kind IN ('payment','refund')),
 resource_id TEXT NOT NULL, reason TEXT NOT NULL, observed_at INTEGER NOT NULL,
 PRIMARY KEY(connection_id,kind,resource_id)
);
CREATE TRIGGER payment_provider_issue_capacity BEFORE INSERT ON payment_provider_issues
WHEN NOT EXISTS(SELECT 1 FROM payment_provider_issues WHERE connection_id=NEW.connection_id AND kind=NEW.kind AND resource_id=NEW.resource_id)
 AND ((SELECT COUNT(*) FROM payment_provider_issues WHERE connection_id=NEW.connection_id)>=1000 OR (SELECT COUNT(*) FROM payment_provider_issues)>=32000)
BEGIN SELECT RAISE(ABORT,'provider issue capacity'); END;
CREATE INDEX payment_provider_issues_observed ON payment_provider_issues(connection_id,observed_at);
