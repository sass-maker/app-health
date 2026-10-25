CREATE INDEX product_pending_workspace ON product_batches(workspace_id,state,expires_at);
CREATE INDEX product_pending_app ON product_batches(workspace_id,app_id,state,expires_at);
-- Retry-safe reservations and bounded, deduplicated archive maintenance.
DROP TRIGGER product_batch_capacity;
DROP TRIGGER product_claim_capacity;
CREATE TRIGGER product_batch_capacity BEFORE INSERT ON product_batches
WHEN NOT EXISTS(SELECT 1 FROM product_batches b WHERE
 (b.workspace_id,b.app_id,b.environment_id,b.channel,b.batch_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.batch_id)) AND (
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=185000 OR
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=925000 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND expires_at>NEW.received_at AND workspace_id=NEW.workspace_id AND app_id=NEW.app_id)>=32 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND expires_at>NEW.received_at AND workspace_id=NEW.workspace_id)>=128)
BEGIN SELECT RAISE(ABORT,'product retained or pending capacity'); END;
CREATE TRIGGER product_claim_capacity BEFORE INSERT ON product_event_claims
WHEN NOT EXISTS(SELECT 1 FROM product_event_claims e WHERE
 (e.workspace_id,e.app_id,e.environment_id,e.channel,e.event_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_id)) AND (
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=185000 OR
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=925000)
BEGIN SELECT RAISE(ABORT,'product retained capacity'); END;

CREATE TRIGGER product_pending_quota_refund AFTER DELETE ON product_batches WHEN OLD.state='pending' BEGIN
 UPDATE product_event_days SET events=events-OLD.input_count,bytes=bytes-OLD.input_bytes
 WHERE workspace_id=OLD.workspace_id AND app_id=OLD.app_id AND day=CAST(OLD.received_at/86400000 AS INTEGER);
 UPDATE product_workspace_days SET events=events-OLD.input_count,bytes=bytes-OLD.input_bytes
 WHERE workspace_id=OLD.workspace_id AND day=CAST(OLD.received_at/86400000 AS INTEGER);
END;
CREATE TABLE product_archive_maintenance (
 id INTEGER PRIMARY KEY CHECK(id=1),wake_token TEXT,wake_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO product_archive_maintenance(id) VALUES(1);
CREATE TRIGGER product_cleanup_insert AFTER INSERT ON product_batches
WHEN NEW.cleanup_at!=CASE WHEN NEW.state='pending' THEN NEW.expires_at WHEN NEW.object_deleted=0 THEN NEW.received_at+2678400000 ELSE MAX(NEW.expires_at,NEW.received_at+3024000000) END
 OR (NEW.state='sealed' AND NEW.expires_at<NEW.received_at+3024000000)
BEGIN
 UPDATE product_batches SET
  expires_at=CASE WHEN NEW.state='sealed' THEN MAX(NEW.expires_at,NEW.received_at+3024000000) ELSE NEW.expires_at END,
  cleanup_at=CASE WHEN NEW.state='pending' THEN NEW.expires_at WHEN NEW.object_deleted=0 THEN NEW.received_at+2678400000 ELSE MAX(NEW.expires_at,NEW.received_at+3024000000) END
 WHERE reservation=NEW.reservation;
END;
CREATE TRIGGER product_cleanup_update AFTER UPDATE OF state,received_at,expires_at,object_deleted ON product_batches
WHEN NEW.cleanup_at!=CASE WHEN NEW.state='pending' THEN NEW.expires_at WHEN NEW.object_deleted=0 THEN NEW.received_at+2678400000 ELSE MAX(NEW.expires_at,NEW.received_at+3024000000) END
 OR (NEW.state='sealed' AND NEW.expires_at<NEW.received_at+3024000000)
BEGIN
 UPDATE product_batches SET
  expires_at=CASE WHEN NEW.state='sealed' THEN MAX(NEW.expires_at,NEW.received_at+3024000000) ELSE NEW.expires_at END,
  cleanup_at=CASE WHEN NEW.state='pending' THEN NEW.expires_at WHEN NEW.object_deleted=0 THEN NEW.received_at+2678400000 ELSE MAX(NEW.expires_at,NEW.received_at+3024000000) END
 WHERE reservation=NEW.reservation;
END;
UPDATE product_batches SET expires_at=CASE WHEN state='sealed' THEN MAX(expires_at,received_at+3024000000) ELSE expires_at END;
