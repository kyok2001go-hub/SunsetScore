"""Validate fresh D1 schema and sequential V2.2.2 -> V2.4.6 migrations."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parent.parent


def sql(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def insert_observation(
    connection, suffix: str, rating: str, label: str, schema_version: int,
    source: str = "user", event_id: str = "evt-test",
) -> None:
    connection.execute(
        """INSERT INTO sunset_observations(
            id, submission_id, event_id, event_date_local, location_key,
            city, latitude, longitude, timezone, sunset_time_utc, sunset_time_local,
            submitted_at_utc, submitted_at_epoch, rating, rating_label, source,
            dataset_schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            f"obs-{suffix}", f"submission-{suffix}", event_id, "2026-09-07", "test:location",
            "深圳", 22.5431, 114.0579, "Asia/Shanghai", "2026-09-07T10:30:00.000Z",
            "2026-09-07 18:30", "2026-09-07T11:00:00.000Z", 1788778800000,
            rating, label, source, schema_version,
        ),
    )


upgrade = sqlite3.connect(":memory:")
upgrade.executescript(sql("migrations/001_initial.sql"))
upgrade.execute(
    """INSERT INTO sunset_feedback(
        id, query_id, created_at, city, latitude, longitude, model_version,
        predicted_score, predicted_level, user_rating, user_rating_label
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
    ("x", "q", "2026-08-26 18:30:00", "Shanghai", 31.2, 121.5,
     "2.2.2", 50, "一般", "fair", "仅微霞"),
)
upgrade.executescript(sql("migrations/002_feedback_time.sql"))
upgrade.executescript(sql("migrations/003_feedback_comment.sql"))
upgrade.executescript(sql("migrations/004_event_dataset.sql"))
upgrade.executescript(sql("migrations/004_event_dataset.sql"))
insert_observation(upgrade, "legacy", "great", "🔥 极佳彩霞", 1)
assert upgrade.execute("SELECT COUNT(*) FROM sunset_observations").fetchone()[0] == 1
upgrade.executescript(sql("migrations/005_observation_rating_v2.sql"))
assert upgrade.execute("SELECT COUNT(*) FROM sunset_observations").fetchone()[0] == 0
assert upgrade.execute("SELECT COUNT(*) FROM sunset_observations_v1_archive").fetchone()[0] == 1
assert upgrade.execute("SELECT rating FROM sunset_observations_v1_archive").fetchone()[0] == "great"
insert_observation(upgrade, "preserved-v2", "very_good", "🌇 很好彩霞", 2)
preserved_before = upgrade.execute(
    "SELECT id, submission_id, rating, source, dataset_schema_version FROM sunset_observations"
).fetchall()
upgrade.executescript(sql("migrations/006_observation_manual_source.sql"))
assert upgrade.execute(
    "SELECT id, submission_id, rating, source, dataset_schema_version FROM sunset_observations"
).fetchall() == preserved_before
assert upgrade.execute("SELECT COUNT(*) FROM sunset_observations_v1_archive").fetchone()[0] == 1
upgrade.executescript(sql("migrations/007_prediction_replay.sql"))
row = upgrade.execute(
    "SELECT created_at_epoch, created_at_utc, app_version, schema_version FROM sunset_feedback"
).fetchone()
expected_epoch = int(datetime(2026, 8, 26, 10, 30, tzinfo=timezone.utc).timestamp() * 1000)
assert row == (expected_epoch, "2026-08-26 10:30:00Z", "2.2.2", 2), row

fresh = sqlite3.connect(":memory:")
fresh.executescript(sql("schema.sql"))
columns = {item[1]: item[3] for item in fresh.execute("PRAGMA table_info(sunset_feedback)")}
for required in ("created_at_epoch", "created_at_utc", "app_version", "schema_version"):
    assert columns.get(required) == 1, f"{required} must be NOT NULL in fresh schema"

for connection in (upgrade, fresh):
    tables = {item[0] for item in connection.execute(
        "SELECT name FROM sqlite_schema WHERE type = 'table'"
    )}
    assert {
        "sunset_feedback", "prediction_snapshots", "sunset_observations",
        "observation_admin_audit",
    } <= tables
    snapshot_columns = {item[1]: item[3] for item in connection.execute(
        "PRAGMA table_info(prediction_snapshots)"
    )}
    observation_columns = {item[1]: item[3] for item in connection.execute(
        "PRAGMA table_info(sunset_observations)"
    )}
    for required in ("idempotency_key", "event_id", "sunset_time_utc", "snapshot_source"):
        assert snapshot_columns.get(required) == 1, f"prediction_snapshots.{required} must be NOT NULL"
    assert snapshot_columns.get("replay_status") == 1
    assert snapshot_columns.get("replay_attempt_count") == 1
    assert snapshot_columns.get("replay_schema_version") == 0
    for required in ("submission_id", "event_id", "submitted_at_utc", "rating_label", "source"):
        assert observation_columns.get(required) == 1, f"sunset_observations.{required} must be NOT NULL"
    assert "observed_at_utc" not in observation_columns

    indexes = {item[1] for item in connection.execute("PRAGMA index_list(sunset_observations)")}
    expected_indexes = {
        "idx_observation_event", "idx_observation_submission", "idx_observation_rate_limit",
        "idx_observation_rating", "idx_observation_source", "idx_observation_manual_event",
    }
    assert expected_indexes <= indexes, indexes
    snapshot_indexes = {item[1] for item in connection.execute("PRAGMA index_list(prediction_snapshots)")}
    assert "idx_snapshot_city_date" in snapshot_indexes, snapshot_indexes
    assert "idx_snapshot_replay_status" in snapshot_indexes, snapshot_indexes
    audit_indexes = {item[1] for item in connection.execute("PRAGMA index_list(observation_admin_audit)")}
    assert {
        "idx_admin_audit_request", "idx_admin_audit_event", "idx_admin_audit_actor",
    } <= audit_indexes, audit_indexes

    ratings = (
        ("excellent", "🔥 极佳彩霞"),
        ("very_good", "🌇 很好彩霞"),
        ("good", "✨ 普通有霞"),
        ("fair", "🌤 仅有微霞"),
        ("poor", "☁️ 完全无霞"),
    )
    for index, (rating, label) in enumerate(ratings):
        insert_observation(connection, f"new-{index}", rating, label, 3)
    try:
        insert_observation(connection, "rejected-great", "great", "🔥 极佳彩霞", 3)
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("sunset_observations must reject the legacy great rating")

    insert_observation(
        connection, "manual", "very_good", "🌇 很好彩霞", 3,
        source="rednote_manual", event_id="evt-manual",
    )
    try:
        insert_observation(
            connection, "manual-duplicate", "good", "✨ 普通有霞", 3,
            source="rednote_manual", event_id="evt-manual",
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("rednote_manual must be unique per event")
    insert_observation(
        connection, "manual-user-same-event", "good", "✨ 普通有霞", 3,
        source="user", event_id="evt-manual",
    )

upgrade_signature = list(upgrade.execute("PRAGMA table_info(sunset_observations)"))
fresh_signature = list(fresh.execute("PRAGMA table_info(sunset_observations)"))
assert upgrade_signature == fresh_signature, "fresh and migrated Observation schemas differ"

upgrade_audit_signature = list(upgrade.execute("PRAGMA table_info(observation_admin_audit)"))
fresh_audit_signature = list(fresh.execute("PRAGMA table_info(observation_admin_audit)"))
assert upgrade_audit_signature == fresh_audit_signature, "fresh and migrated audit schemas differ"

upgrade_snapshot_signature = list(upgrade.execute("PRAGMA table_info(prediction_snapshots)"))
fresh_snapshot_signature = list(fresh.execute("PRAGMA table_info(prediction_snapshots)"))
assert upgrade_snapshot_signature == fresh_snapshot_signature, "fresh and migrated Snapshot schemas differ"

print("D1 V2.4.6 schema and sequential migrations passed")
