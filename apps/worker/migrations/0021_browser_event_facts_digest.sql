-- Versioned digest identifies accepted event facts without retaining event payload in D1.
-- NULL on pre-existing 0019/0020 rows means the historical batch is unverified.
ALTER TABLE browser_visitor_batch_receipts
  ADD COLUMN facts_digest_version INTEGER CHECK (facts_digest_version IS NULL OR facts_digest_version = 1);
ALTER TABLE browser_visitor_batch_receipts
  ADD COLUMN facts_digest TEXT CHECK (facts_digest IS NULL OR length(facts_digest) = 64);

CREATE INDEX IF NOT EXISTS idx_browser_visitor_batch_receipts_facts_digest
  ON browser_visitor_batch_receipts (facts_digest_version, facts_digest);
