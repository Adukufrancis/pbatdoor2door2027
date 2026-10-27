-- Per-IP limit on how many codes can be requested (sliding one-hour window).
-- Kept in the database so it survives restarts and is shared by every app instance.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bucket  TEXT NOT NULL,
  hit_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_bucket_at_idx ON rate_limit_hits (bucket, hit_at);
CREATE INDEX IF NOT EXISTS rate_limit_hits_at_idx ON rate_limit_hits (hit_at);

-- Housekeeping deletes expired codes by expiry time.
CREATE INDEX IF NOT EXISTS otp_codes_expires_at_idx ON otp_codes (expires_at);

-- "Signed-in devices" lists a member's sessions newest first.
CREATE INDEX IF NOT EXISTS member_sessions_member_last_seen_idx ON member_sessions (member_id, last_seen DESC);
DROP INDEX IF EXISTS member_sessions_member_idx;
