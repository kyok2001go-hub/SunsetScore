-- Upgrade a V2.2.2 sunset_feedback table to V2.3 UTC/epoch semantics.
ALTER TABLE sunset_feedback ADD COLUMN created_at_epoch INTEGER;
ALTER TABLE sunset_feedback ADD COLUMN created_at_utc TEXT;
ALTER TABLE sunset_feedback ADD COLUMN app_version TEXT;
ALTER TABLE sunset_feedback ADD COLUMN schema_version INTEGER;

UPDATE sunset_feedback
SET created_at_epoch = CAST(strftime('%s', created_at, '-8 hours') AS INTEGER) * 1000
WHERE created_at_epoch IS NULL;

UPDATE sunset_feedback
SET created_at_utc = datetime(created_at, '-8 hours') || 'Z'
WHERE created_at_utc IS NULL;

UPDATE sunset_feedback SET app_version = COALESCE(model_version, '2.2.2') WHERE app_version IS NULL;
UPDATE sunset_feedback SET schema_version = 2 WHERE schema_version IS NULL;

CREATE INDEX IF NOT EXISTS idx_fb_created_epoch ON sunset_feedback(created_at_epoch);
CREATE INDEX IF NOT EXISTS idx_fb_rate_limit ON sunset_feedback(user_ip_hash, city, created_at_epoch);
