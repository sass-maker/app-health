-- Preserve every v1 receipt; independently authenticate expanded event facts.
ALTER TABLE browser_visitor_batch_receipts ADD COLUMN expanded_facts_digest TEXT
  CHECK (expanded_facts_digest IS NULL OR length(expanded_facts_digest) = 64);
-- Claim batch identities before enqueueing, including session-only clients.
-- Digests only: no event payloads or unhashed browser identity in D1.
CREATE TABLE IF NOT EXISTS browser_expanded_batch_claims (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK(length(digest) = 64),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, app_id, environment_id, batch_id)
);
CREATE INDEX IF NOT EXISTS browser_expanded_batch_claims_expiry
  ON browser_expanded_batch_claims(expires_at);
