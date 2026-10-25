-- Sustainable 35-day identity retention plus one full calendar-day admission boundary.
ALTER TABLE product_batches ADD COLUMN cleanup_at INTEGER NOT NULL DEFAULT 0;
UPDATE product_batches SET cleanup_at=CASE WHEN state='pending' THEN expires_at WHEN object_deleted=0 THEN received_at+2678400000 ELSE expires_at END;
CREATE INDEX product_batches_cleanup ON product_batches(cleanup_at,reservation);
CREATE TABLE product_object_gc (object_key TEXT PRIMARY KEY, cleanup_at INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('fence','delete')));
CREATE INDEX product_object_gc_due ON product_object_gc(cleanup_at,object_key);
CREATE TRIGGER product_pending_gc AFTER DELETE ON product_batches WHEN OLD.state='pending' BEGIN
 INSERT OR IGNORE INTO product_object_gc VALUES(OLD.object_key,OLD.expires_at,'fence');
END;
CREATE TABLE product_workspace_days (workspace_id TEXT NOT NULL,day INTEGER NOT NULL,events INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(workspace_id,day));
INSERT INTO product_workspace_days SELECT workspace_id,day,SUM(events),SUM(bytes) FROM product_event_days GROUP BY workspace_id,day;
DROP TRIGGER product_batch_capacity;
DROP TRIGGER product_claim_capacity;
DROP TRIGGER product_batch_added;
DROP TRIGGER product_claim_added;
DROP TRIGGER product_batch_removed;
DROP TRIGGER product_claim_removed;
DELETE FROM product_event_usage WHERE scope='global';
CREATE TRIGGER product_batch_capacity BEFORE INSERT ON product_batches
WHEN NOT EXISTS(SELECT 1 FROM product_batches b WHERE
 (b.workspace_id,b.app_id,b.environment_id,b.channel,b.batch_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.batch_id)) AND (
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=180000 OR
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=900000 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND workspace_id=NEW.workspace_id AND app_id=NEW.app_id)>=32 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND workspace_id=NEW.workspace_id)>=128)
BEGIN SELECT RAISE(ABORT,'product retained or pending capacity'); END;
CREATE TRIGGER product_claim_capacity BEFORE INSERT ON product_event_claims
WHEN NOT EXISTS(SELECT 1 FROM product_event_claims e WHERE
 (e.workspace_id,e.app_id,e.environment_id,e.channel,e.event_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_id)) AND (
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=180000 OR
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=900000)
BEGIN SELECT RAISE(ABORT,'product retained capacity'); END;
CREATE TRIGGER product_workspace_daily BEFORE INSERT ON product_batches
WHEN NOT EXISTS(SELECT 1 FROM product_batches b WHERE
 (b.workspace_id,b.app_id,b.environment_id,b.channel,b.batch_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.batch_id)) AND EXISTS(
 SELECT 1 FROM product_workspace_days d WHERE d.workspace_id=NEW.workspace_id AND d.day=CAST(NEW.received_at/86400000 AS INTEGER)
 AND (d.events+NEW.input_count>25000 OR d.bytes+NEW.input_bytes>41943040))
BEGIN SELECT RAISE(ABORT,'product workspace daily capacity'); END;
CREATE TRIGGER product_batch_added AFTER INSERT ON product_batches BEGIN
 INSERT INTO product_event_usage(scope,receipts) VALUES('w:'||NEW.workspace_id,1),('a:'||NEW.workspace_id||':'||NEW.app_id,1)
 ON CONFLICT(scope) DO UPDATE SET receipts=receipts+1;
 INSERT INTO product_event_days VALUES(NEW.workspace_id,NEW.app_id,CAST(NEW.received_at/86400000 AS INTEGER),NEW.input_count,NEW.input_bytes)
 ON CONFLICT(workspace_id,app_id,day) DO UPDATE SET events=events+NEW.input_count,bytes=bytes+NEW.input_bytes;
 INSERT INTO product_workspace_days VALUES(NEW.workspace_id,CAST(NEW.received_at/86400000 AS INTEGER),NEW.input_count,NEW.input_bytes)
 ON CONFLICT(workspace_id,day) DO UPDATE SET events=events+NEW.input_count,bytes=bytes+NEW.input_bytes;
END;
CREATE TRIGGER product_claim_added AFTER INSERT ON product_event_claims BEGIN
 INSERT INTO product_event_usage(scope,claims) VALUES('w:'||NEW.workspace_id,1),('a:'||NEW.workspace_id||':'||NEW.app_id,1)
 ON CONFLICT(scope) DO UPDATE SET claims=claims+1;
END;
CREATE TRIGGER product_batch_removed AFTER DELETE ON product_batches BEGIN
 UPDATE product_event_usage SET receipts=receipts-1 WHERE scope IN ('w:'||OLD.workspace_id,'a:'||OLD.workspace_id||':'||OLD.app_id);
END;
CREATE TRIGGER product_claim_removed AFTER DELETE ON product_event_claims BEGIN
 UPDATE product_event_usage SET claims=claims-1 WHERE scope IN ('w:'||OLD.workspace_id,'a:'||OLD.workspace_id||':'||OLD.app_id);
END;
