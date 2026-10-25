-- Only deduplication/control metadata lives in D1; canonical event bytes live in R2.
CREATE TABLE product_batches (
  workspace_id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('server','manual','browser')), batch_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest)=64), reservation TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','sealed')), object_key TEXT NOT NULL,
  object_hash TEXT, object_bytes INTEGER, object_deleted INTEGER NOT NULL DEFAULT 0 CHECK(object_deleted IN (0,1)), input_count INTEGER NOT NULL,
  input_bytes INTEGER NOT NULL, accepted_count INTEGER NOT NULL DEFAULT 0, min_time INTEGER NOT NULL, max_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,app_id,environment_id,channel,batch_id)
);
CREATE INDEX product_batches_scope ON product_batches(workspace_id,app_id,environment_id,state,min_time,max_time);
CREATE INDEX product_batches_expiry ON product_batches(state,expires_at);
CREATE TABLE product_event_claims (
  workspace_id TEXT NOT NULL, app_id TEXT NOT NULL, environment_id TEXT NOT NULL, channel TEXT NOT NULL,
  event_id TEXT NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64), reservation TEXT NOT NULL REFERENCES product_batches(reservation),
  PRIMARY KEY(workspace_id,app_id,environment_id,channel,event_id)
);
CREATE INDEX product_claims_owner ON product_event_claims(reservation);
CREATE TABLE product_event_usage (
  scope TEXT PRIMARY KEY, claims INTEGER NOT NULL DEFAULT 0 CHECK(claims>=0), receipts INTEGER NOT NULL DEFAULT 0 CHECK(receipts>=0)
);
CREATE TABLE product_event_days (
  workspace_id TEXT NOT NULL, app_id TEXT NOT NULL, day INTEGER NOT NULL,
  events INTEGER NOT NULL, bytes INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,app_id,day), CHECK(events<=5000 AND bytes<=8388608)
);
CREATE TRIGGER product_batch_conflict BEFORE INSERT ON product_batches
WHEN EXISTS(SELECT 1 FROM product_batches b WHERE
 (b.workspace_id,b.app_id,b.environment_id,b.channel,b.batch_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.batch_id) AND b.digest!=NEW.digest)
BEGIN SELECT RAISE(ABORT,'product batch identity conflict'); END;
CREATE TRIGGER product_claim_conflict BEFORE INSERT ON product_event_claims
WHEN EXISTS(SELECT 1 FROM product_event_claims e WHERE
 (e.workspace_id,e.app_id,e.environment_id,e.channel,e.event_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_id) AND e.digest!=NEW.digest)
BEGIN SELECT RAISE(ABORT,'product event identity conflict'); END;
CREATE TRIGGER product_claim_pending BEFORE INSERT ON product_event_claims
WHEN EXISTS(SELECT 1 FROM product_event_claims e JOIN product_batches b ON b.reservation=e.reservation WHERE
 (e.workspace_id,e.app_id,e.environment_id,e.channel,e.event_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_id)
 AND e.reservation!=NEW.reservation AND b.state='pending')
BEGIN SELECT RAISE(ABORT,'product original pending'); END;
CREATE TRIGGER product_batch_capacity BEFORE INSERT ON product_batches
WHEN NOT EXISTS(SELECT 1 FROM product_batches b WHERE
 (b.workspace_id,b.app_id,b.environment_id,b.channel,b.batch_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.batch_id)) AND (
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=4000 OR
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=16000 OR
 COALESCE((SELECT receipts FROM product_event_usage WHERE scope='global'),0)>=64000 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND workspace_id=NEW.workspace_id AND app_id=NEW.app_id)>=32 OR
 (SELECT COUNT(*) FROM product_batches WHERE state='pending' AND workspace_id=NEW.workspace_id)>=128)
BEGIN SELECT RAISE(ABORT,'product archive capacity'); END;
CREATE TRIGGER product_claim_capacity BEFORE INSERT ON product_event_claims
WHEN NOT EXISTS(SELECT 1 FROM product_event_claims e WHERE
 (e.workspace_id,e.app_id,e.environment_id,e.channel,e.event_id)=(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_id)) AND (
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='a:'||NEW.workspace_id||':'||NEW.app_id),0)>=50000 OR
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='w:'||NEW.workspace_id),0)>=100000 OR
 COALESCE((SELECT claims FROM product_event_usage WHERE scope='global'),0)>=500000)
BEGIN SELECT RAISE(ABORT,'product archive capacity'); END;
CREATE TRIGGER product_batch_added AFTER INSERT ON product_batches BEGIN
 INSERT INTO product_event_usage(scope,receipts) VALUES('global',1),('w:'||NEW.workspace_id,1),('a:'||NEW.workspace_id||':'||NEW.app_id,1)
 ON CONFLICT(scope) DO UPDATE SET receipts=receipts+1;
 INSERT INTO product_event_days VALUES(NEW.workspace_id,NEW.app_id,CAST(NEW.received_at/86400000 AS INTEGER),NEW.input_count,NEW.input_bytes)
 ON CONFLICT(workspace_id,app_id,day) DO UPDATE SET events=events+NEW.input_count,bytes=bytes+NEW.input_bytes;
END;
CREATE TRIGGER product_claim_added AFTER INSERT ON product_event_claims BEGIN
 INSERT INTO product_event_usage(scope,claims) VALUES('global',1),('w:'||NEW.workspace_id,1),('a:'||NEW.workspace_id||':'||NEW.app_id,1)
 ON CONFLICT(scope) DO UPDATE SET claims=claims+1;
END;
CREATE TRIGGER product_batch_removed AFTER DELETE ON product_batches BEGIN
 UPDATE product_event_usage SET receipts=receipts-1 WHERE scope IN ('global','w:'||OLD.workspace_id,'a:'||OLD.workspace_id||':'||OLD.app_id);
END;
CREATE TRIGGER product_claim_removed AFTER DELETE ON product_event_claims BEGIN
 UPDATE product_event_usage SET claims=claims-1 WHERE scope IN ('global','w:'||OLD.workspace_id,'a:'||OLD.workspace_id||':'||OLD.app_id);
END;

CREATE TABLE product_archive_cleanup (id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT);
