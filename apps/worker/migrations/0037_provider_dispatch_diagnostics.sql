ALTER TABLE payment_provider_jobs ADD COLUMN wake_token TEXT;
ALTER TABLE payment_provider_jobs ADD COLUMN wake_until INTEGER NOT NULL DEFAULT 0;
CREATE INDEX payment_provider_wake_due ON payment_provider_jobs(wake_until,updated_at);
CREATE TABLE payment_provider_issue_state (
 connection_id TEXT PRIMARY KEY REFERENCES payment_connections(id),
 truncated INTEGER NOT NULL DEFAULT 1 CHECK(truncated=1)
);
DROP TRIGGER payment_provider_issue_capacity;
CREATE TRIGGER payment_provider_issue_capacity BEFORE INSERT ON payment_provider_issues
WHEN NOT EXISTS(SELECT 1 FROM payment_provider_issues WHERE connection_id=NEW.connection_id AND kind=NEW.kind AND resource_id=NEW.resource_id)
 AND (SELECT COUNT(*) FROM payment_provider_issues WHERE connection_id=NEW.connection_id)>=1000
BEGIN
 INSERT OR IGNORE INTO payment_provider_issue_state(connection_id) VALUES(NEW.connection_id);
 SELECT RAISE(IGNORE);
END;
CREATE INDEX payment_provider_issue_expiry ON payment_provider_issues(observed_at);
