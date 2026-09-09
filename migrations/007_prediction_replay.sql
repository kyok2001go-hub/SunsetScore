-- SunsetScore V2.4.6 - L2 Engine Replay lifecycle metadata.
-- Dataset schema remains 3; Replay has its own replay_schema_version.
ALTER TABLE prediction_snapshots ADD COLUMN replay_status TEXT NOT NULL DEFAULT 'NONE'
  CHECK (replay_status IN ('NONE', 'PENDING', 'READY', 'FAILED'));
ALTER TABLE prediction_snapshots ADD COLUMN replay_schema_version INTEGER
  CHECK (replay_schema_version IS NULL OR replay_schema_version >= 1);
ALTER TABLE prediction_snapshots ADD COLUMN replay_object_key TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_size_bytes INTEGER
  CHECK (replay_size_bytes IS NULL OR replay_size_bytes >= 0);
ALTER TABLE prediction_snapshots ADD COLUMN replay_sha256 TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_object_etag TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_compression TEXT
  CHECK (replay_compression IS NULL OR replay_compression = 'gzip');
ALTER TABLE prediction_snapshots ADD COLUMN replay_saved_at_utc TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_updated_at_utc TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_error_code TEXT;
ALTER TABLE prediction_snapshots ADD COLUMN replay_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (replay_attempt_count >= 0);

CREATE INDEX idx_snapshot_replay_status
ON prediction_snapshots(replay_status, replay_updated_at_utc);
