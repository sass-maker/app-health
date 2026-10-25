ALTER TABLE payment_provider_issue_state ADD COLUMN first_omitted_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_provider_issue_state ADD COLUMN last_omitted_at INTEGER NOT NULL DEFAULT 0;
-- Legacy flags have unknown omission dates: preserve a conservative possible interval.
UPDATE payment_provider_issue_state SET first_omitted_at=(SELECT created_at FROM payment_connections WHERE id=connection_id),last_omitted_at=CAST(strftime('%s','now') AS INTEGER)*1000;
CREATE INDEX payment_provider_omission_expiry ON payment_provider_issue_state(last_omitted_at);
DROP TRIGGER payment_provider_issue_capacity;
CREATE TRIGGER payment_provider_issue_capacity BEFORE INSERT ON payment_provider_issues
WHEN NOT EXISTS(SELECT 1 FROM payment_provider_issues WHERE connection_id=NEW.connection_id AND kind=NEW.kind AND resource_id=NEW.resource_id)
 AND (SELECT COUNT(*) FROM payment_provider_issues WHERE connection_id=NEW.connection_id)>=1000
BEGIN
 INSERT INTO payment_provider_issue_state(connection_id,truncated,first_omitted_at,last_omitted_at) VALUES(NEW.connection_id,1,NEW.observed_at,NEW.observed_at)
 ON CONFLICT(connection_id) DO UPDATE SET first_omitted_at= CASE WHEN last_omitted_at<NEW.observed_at-2678400000 THEN NEW.observed_at ELSE MIN(first_omitted_at,NEW.observed_at) END,last_omitted_at=MAX(last_omitted_at,NEW.observed_at);
 SELECT RAISE(IGNORE);
END;
