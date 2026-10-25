-- Accepted raw objects remain immutable; this index publishes replaceable report snapshots.
CREATE TABLE product_report_segments (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,app_id TEXT NOT NULL,environment_id TEXT NOT NULL,channel TEXT NOT NULL,
 event_day INTEGER NOT NULL,level INTEGER NOT NULL,format INTEGER NOT NULL CHECK(format IN (1,2)),
 reservation TEXT,batch_id TEXT,object_key TEXT NOT NULL,object_hash TEXT NOT NULL,object_bytes INTEGER NOT NULL,
 event_count INTEGER NOT NULL,min_time INTEGER NOT NULL,max_time INTEGER NOT NULL,received_at INTEGER NOT NULL,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),cleanup_at INTEGER NOT NULL
);
CREATE INDEX product_report_scope ON product_report_segments(workspace_id,app_id,environment_id,active,min_time,max_time);
CREATE INDEX product_report_compact ON product_report_segments(workspace_id,app_id,environment_id,channel,event_day,active,level,object_bytes,id);
CREATE INDEX product_report_cleanup ON product_report_segments(cleanup_at,id);
CREATE TABLE product_compaction_jobs (
 workspace_id TEXT NOT NULL,app_id TEXT NOT NULL,environment_id TEXT NOT NULL,channel TEXT NOT NULL,event_day INTEGER NOT NULL,
 closed INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 1,dirty INTEGER NOT NULL DEFAULT 1,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,app_id,environment_id,channel,event_day)
);
CREATE INDEX product_compaction_due ON product_compaction_jobs(dirty,lease_until,event_day);
CREATE INDEX product_compaction_closed ON product_compaction_jobs(closed,event_day,lease_until);
CREATE TRIGGER product_segment_added AFTER INSERT ON product_report_segments WHEN NEW.active=1 BEGIN
 INSERT INTO product_compaction_jobs(workspace_id,app_id,environment_id,channel,event_day) VALUES(NEW.workspace_id,NEW.app_id,NEW.environment_id,NEW.channel,NEW.event_day)
 ON CONFLICT(workspace_id,app_id,environment_id,channel,event_day) DO UPDATE SET epoch=epoch+1,dirty=1;
END;
INSERT INTO product_report_segments
 SELECT reservation,workspace_id,app_id,environment_id,channel,CAST(received_at/86400000 AS INTEGER),0,1,reservation,batch_id,object_key,object_hash,object_bytes,accepted_count,min_time,max_time,received_at,1,received_at+2678400000
 FROM product_batches WHERE state='sealed' AND accepted_count>0 AND object_deleted=0;
