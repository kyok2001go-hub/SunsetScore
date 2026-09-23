CREATE INDEX IF NOT EXISTS idx_snapshot_admin_date
ON prediction_snapshots(event_date_local, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_admin_predicted_level
ON prediction_snapshots(predicted_level, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_admin_baseline_level
ON prediction_snapshots(baseline_level, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_admin_regime
ON prediction_snapshots(regime_label, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_admin_sky_state
ON prediction_snapshots(sky_evolution_state, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_snapshot_admin_source
ON prediction_snapshots(snapshot_source, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_observation_admin_date
ON sunset_observations(event_date_local, submitted_at_epoch DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_observation_admin_city_date
ON sunset_observations(city COLLATE NOCASE, event_date_local, submitted_at_epoch DESC, id DESC);
