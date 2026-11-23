-- Preserve threshold-resolved evidence for V2 samples in the (500, 1000] bin.
-- Older writers omit these additive columns, so their h8 samples remain
-- conservatively ambiguous after a rollback or mixed-version write.
ALTER TABLE endpoint_rollups
  ADD COLUMN h8_classified_count INTEGER NOT NULL DEFAULT 0 CHECK (h8_classified_count >= 0);

ALTER TABLE endpoint_rollups
  ADD COLUMN h8_exact_1000ms_count INTEGER NOT NULL DEFAULT 0 CHECK (h8_exact_1000ms_count >= 0);
