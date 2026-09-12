-- Opt-in public analytics breakdowns; existing links remain aggregate-only.
ALTER TABLE analytics_shares
  ADD COLUMN include_breakdowns INTEGER NOT NULL DEFAULT 0;
