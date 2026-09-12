-- Expression indexes keep the bounded account-retention sweep index-backed.
CREATE INDEX IF NOT EXISTS idx_session_retention_expiry ON session (
  (CASE
    WHEN typeof(expiresAt) IN ('integer', 'real')
      OR (typeof(expiresAt) = 'text' AND trim(expiresAt) <> '' AND trim(expiresAt) NOT GLOB '*[^0-9.]*')
    THEN CAST(expiresAt AS REAL) / 1000.0
    ELSE (julianday(expiresAt) - 2440587.5) * 86400.0
  END)
);
CREATE INDEX IF NOT EXISTS idx_verification_retention_expiry ON verification (
  (CASE
    WHEN typeof(expiresAt) IN ('integer', 'real')
      OR (typeof(expiresAt) = 'text' AND trim(expiresAt) <> '' AND trim(expiresAt) NOT GLOB '*[^0-9.]*')
    THEN CAST(expiresAt AS REAL) / 1000.0
    ELSE (julianday(expiresAt) - 2440587.5) * 86400.0
  END)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_retention_last_request ON rateLimit (lastRequest);
