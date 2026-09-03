-- SunsetScore V2.4.0 - event-level training dataset
-- Additive and repeatable: the legacy sunset_feedback table is intentionally untouched.

CREATE TABLE IF NOT EXISTS prediction_snapshots (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_id TEXT NOT NULL,
    event_date_local TEXT NOT NULL,
    location_key TEXT NOT NULL,

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
    sunset_azimuth REAL,
    twilight_minutes INTEGER,
    best_viewing_window TEXT,

    query_id TEXT NOT NULL,
    prediction_time_utc TEXT NOT NULL,
    prediction_time_epoch INTEGER NOT NULL,
    submitted_at_utc TEXT NOT NULL,
    submitted_at_epoch INTEGER NOT NULL,
    snapshot_source TEXT NOT NULL CHECK (snapshot_source IN ('github_schedule', 'github_manual', 'user_feedback')),
    scheduled_slot TEXT CHECK (scheduled_slot IS NULL OR (length(scheduled_slot) = 4 AND scheduled_slot NOT GLOB '*[^0-9]*')),

    app_version TEXT NOT NULL,
    model_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    dataset_schema_version INTEGER NOT NULL,
    asset_revision TEXT,
    predicted_score INTEGER NOT NULL CHECK (predicted_score BETWEEN 0 AND 100),
    predicted_level TEXT NOT NULL,
    baseline_score INTEGER,
    baseline_level TEXT,
    regime_label TEXT,
    regime_strength REAL,
    sky_evolution_state TEXT,
    sky_evolution_factor REAL,
    gw_factor REAL,

    comp_sky_canvas INTEGER,
    comp_horizon INTEGER,
    comp_illumination INTEGER,
    comp_atmosphere INTEGER,
    comp_weather INTEGER,
    cloud_cover_total INTEGER,
    cloud_cover_low INTEGER,
    cloud_cover_mid INTEGER,
    cloud_cover_high INTEGER,
    corridor_cloud_mid REAL,
    corridor_cloud_high REAL,
    anti_sunset_score INTEGER,
    spatial_variance REAL,
    cloud_continuity INTEGER,

    aod REAL,
    pm25 REAL,
    humidity REAL,
    surface_pressure REAL,
    visibility_km REAL,
    precipitation REAL,

    layer_wind_850_speed REAL,
    layer_wind_850_dir REAL,
    layer_wind_700_speed REAL,
    layer_wind_700_dir REAL,
    layer_wind_500_speed REAL,
    layer_wind_500_dir REAL,
    is_real_sounding INTEGER DEFAULT 0 CHECK (is_real_sounding IN (0, 1)),

    open_prob_30m REAL,
    open_prob_60m REAL,
    open_prob_120m REAL,
    arrival_risk_30m REAL,
    arrival_risk_60m REAL,
    tile_radar_available INTEGER DEFAULT 0 CHECK (tile_radar_available IN (0, 1)),
    tile_sat_available INTEGER DEFAULT 0 CHECK (tile_sat_available IN (0, 1)),

    dyn_weight_canvas REAL,
    dyn_weight_horizon REAL,
    dyn_weight_illum REAL,
    dyn_weight_atmo REAL,
    dyn_weight_weather REAL,

    raw_snapshot_json TEXT
);

CREATE TABLE IF NOT EXISTS sunset_observations (
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
    rating TEXT NOT NULL CHECK (rating IN ('great', 'good', 'fair', 'poor')),
    rating_label TEXT NOT NULL,
    comment TEXT,
    source TEXT NOT NULL CHECK (source IN ('user', 'rednote_agent')),
    confidence REAL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 1)),
    evidence_count INTEGER CHECK (evidence_count IS NULL OR evidence_count >= 0),
    user_ip_hash TEXT,
    client_ua TEXT,
    dataset_schema_version INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshot_event ON prediction_snapshots(event_id, prediction_time_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_idempotency ON prediction_snapshots(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_snapshot_source_slot ON prediction_snapshots(snapshot_source, scheduled_slot, event_date_local);
CREATE INDEX IF NOT EXISTS idx_snapshot_model ON prediction_snapshots(model_version);
CREATE INDEX IF NOT EXISTS idx_observation_event ON sunset_observations(event_id, submitted_at_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_observation_submission ON sunset_observations(submission_id);
CREATE INDEX IF NOT EXISTS idx_observation_rate_limit ON sunset_observations(user_ip_hash, city, submitted_at_epoch);
CREATE INDEX IF NOT EXISTS idx_observation_rating ON sunset_observations(rating);
CREATE INDEX IF NOT EXISTS idx_observation_source ON sunset_observations(source);
