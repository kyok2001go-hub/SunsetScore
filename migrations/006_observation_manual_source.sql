-- V2.4.5: add administrator-created Observation labels without changing
-- historical snapshots or dropping any active five-level Observation rows.

CREATE TABLE sunset_observations_new (
    id TEXT PRIMARY KEY,
    submission_id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    event_date_local TEXT NOT NULL,
    location_key TEXT NOT NULL,
    snapshot_id TEXT,

    city TEXT NOT NULL,
    country TEXT,
    admin1 TEXT,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    location_source TEXT,
    location_id TEXT,
    timezone TEXT NOT NULL,
    sunset_time_utc TEXT NOT NULL,
    sunset_time_local TEXT NOT NULL,

    submitted_at_utc TEXT NOT NULL,
    submitted_at_epoch INTEGER NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('excellent', 'very_good', 'good', 'fair', 'poor')),
    rating_label TEXT NOT NULL,
    comment TEXT,
    source TEXT NOT NULL CHECK (source IN ('user', 'rednote_agent', 'rednote_manual')),
    confidence REAL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
    evidence_count INTEGER CHECK (evidence_count IS NULL OR evidence_count >= 0),
    user_ip_hash TEXT,
    client_ua TEXT,
    dataset_schema_version INTEGER NOT NULL
);

INSERT INTO sunset_observations_new (
    id, submission_id, event_id, event_date_local, location_key, snapshot_id,
    city, country, admin1, latitude, longitude, location_source, location_id,
    timezone, sunset_time_utc, sunset_time_local, submitted_at_utc,
    submitted_at_epoch, rating, rating_label, comment, source, confidence,
    evidence_count, user_ip_hash, client_ua, dataset_schema_version
)
SELECT
    id, submission_id, event_id, event_date_local, location_key, snapshot_id,
    city, country, admin1, latitude, longitude, location_source, location_id,
    timezone, sunset_time_utc, sunset_time_local, submitted_at_utc,
    submitted_at_epoch, rating, rating_label, comment, source, confidence,
    evidence_count, user_ip_hash, client_ua, dataset_schema_version
FROM sunset_observations;

DROP INDEX IF EXISTS idx_observation_event;
DROP INDEX IF EXISTS idx_observation_submission;
DROP INDEX IF EXISTS idx_observation_rate_limit;
DROP INDEX IF EXISTS idx_observation_rating;
DROP INDEX IF EXISTS idx_observation_source;

DROP TABLE sunset_observations;
ALTER TABLE sunset_observations_new RENAME TO sunset_observations;

CREATE INDEX idx_observation_event ON sunset_observations(event_id, submitted_at_epoch);
CREATE UNIQUE INDEX idx_observation_submission ON sunset_observations(submission_id);
CREATE INDEX idx_observation_rate_limit ON sunset_observations(user_ip_hash, city, submitted_at_epoch);
CREATE INDEX idx_observation_rating ON sunset_observations(rating);
CREATE INDEX idx_observation_source ON sunset_observations(source);
CREATE UNIQUE INDEX idx_observation_manual_event
ON sunset_observations(event_id)
WHERE source = 'rednote_manual';
CREATE INDEX IF NOT EXISTS idx_snapshot_city_date
ON prediction_snapshots(city COLLATE NOCASE, event_date_local, event_id);

CREATE TABLE observation_admin_audit (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    observation_id TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action = 'create'),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('human', 'service')),
    actor_subject TEXT NOT NULL,
    actor_email TEXT,
    created_at_utc TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL
);

CREATE INDEX idx_admin_audit_request ON observation_admin_audit(request_id);
CREATE INDEX idx_admin_audit_event ON observation_admin_audit(event_id, created_at_epoch);
CREATE INDEX idx_admin_audit_actor ON observation_admin_audit(actor_subject, created_at_epoch);
