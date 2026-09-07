"""Validate fresh D1 schema and sequential V2.2.2 -> V2.4.4 migrations."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parent.parent


def sql(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def insert_observation(connection, suffix: str, rating: str, label: str, schema_version: int) -> None:
    connection.execute(
        """INSERT INTO sunset_observations(
            id, submission_id, event_id, event_date_local, location_key,
            city, latitude, longitude, timezone, sunset_time_utc, sunset_time_local,
            submitted_at_utc, submitted_at_epoch, rating, rating_label, source,
            dataset_schema_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            f"obs-{suffix}", f"submission-{suffix}", "evt-test", "2026-09-07", "test:location",
            "深圳", 22.5431, 114.0579, "Asia/Shanghai", "2026-09-07T10:30:00.000Z",
            "2026-09-07 18:30", "2026-09-07T11:00:00.000Z", 1788778800000,
            rating, label, "user", schema_version,
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
    assert {"sunset_feedback", "prediction_snapshots", "sunset_observations"} <= tables
    snapshot_columns = {item[1]: item[3] for item in connection.execute(
        "PRAGMA table_info(prediction_snapshots)"
    )}
    observation_columns = {item[1]: item[3] for item in connection.execute(
        "PRAGMA table_info(sunset_observations)"
    )}
    for required in ("idempotency_key", "event_id", "sunset_time_utc", "snapshot_source"):
        assert snapshot_columns.get(required) == 1, f"prediction_snapshots.{required} must be NOT NULL"
    for required in ("submission_id", "event_id", "submitted_at_utc", "rating_label", "source"):
        assert observation_columns.get(required) == 1, f"sunset_observations.{required} must be NOT NULL"
    assert "observed_at_utc" not in observation_columns

    indexes = {item[1] for item in connection.execute("PRAGMA index_list(sunset_observations)")}
    expected_indexes = {
        "idx_observation_event", "idx_observation_submission", "idx_observation_rate_limit",
        "idx_observation_rating", "idx_observation_source",
    }
    assert expected_indexes <= indexes, indexes

    ratings = (
        ("excellent", "🔥 极佳彩霞"),
        ("very_good", "🌇 很好彩霞"),
        ("good", "✨ 普通有霞"),
        ("fair", "🌤 仅有微霞"),
        ("poor", "☁️ 完全无霞"),
    )
    for index, (rating, label) in enumerate(ratings):
        insert_observation(connection, f"new-{index}", rating, label, 2)
    try:
        insert_observation(connection, "rejected-great", "great", "🔥 极佳彩霞", 2)
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("sunset_observations must reject the legacy great rating")

upgrade_signature = list(upgrade.execute("PRAGMA table_info(sunset_observations)"))
fresh_signature = list(fresh.execute("PRAGMA table_info(sunset_observations)"))
assert upgrade_signature == fresh_signature, "fresh and migrated Observation schemas differ"

print("D1 V2.4.4 schema and sequential migrations passed")
