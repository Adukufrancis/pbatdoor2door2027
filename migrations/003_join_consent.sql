-- Join-time Privacy/Terms agreement and optional SMS/WhatsApp opt-in.
-- Distinct from consent_at, which is still recorded when the profile is first saved.
ALTER TABLE members ADD COLUMN IF NOT EXISTS join_consent_at BIGINT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS sms_consent_at BIGINT;
