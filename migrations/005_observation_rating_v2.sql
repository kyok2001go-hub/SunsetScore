-- V2.4.4: replace the Observation rating contract with five ordered labels.
-- Historical sunset_observations rows are intentionally not migrated into the
-- active V2 table. Preserve them in a read-only legacy archive for audit and
-- rollback safety.

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
    source TEXT NOT NULL CHECK (source IN ('user', 'rednote_agent')),
    confidence REAL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
    evidence_count INTEGER CHECK (evidence_count IS NULL OR evidence_count >= 0),
    user_ip_hash TEXT,
    client_ua TEXT,
    dataset_schema_version INTEGER NOT NULL
);

DROP INDEX IF EXISTS idx_observation_event;
DROP INDEX IF EXISTS idx_observation_submission;
DROP INDEX IF EXISTS idx_observation_rate_limit;
DROP INDEX IF EXISTS idx_observation_rating;
DROP INDEX IF EXISTS idx_observation_source;

ALTER TABLE sunset_observations RENAME TO sunset_observations_v1_archive;
ALTER TABLE sunset_observations_new RENAME TO sunset_observations;

CREATE INDEX idx_observation_event ON sunset_observations(event_id, submitted_at_epoch);
CREATE UNIQUE INDEX idx_observation_submission ON sunset_observations(submission_id);
CREATE INDEX idx_observation_rate_limit ON sunset_observations(user_ip_hash, city, submitted_at_epoch);
CREATE INDEX idx_observation_rating ON sunset_observations(rating);
CREATE INDEX idx_observation_source ON sunset_observations(source);
