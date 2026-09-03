"""Validate fresh D1 schema and sequential V2.2.2 -> V2.4 migrations."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3


ROOT = Path(__file__).resolve().parent.parent


def sql(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


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

print("D1 V2.4 schema and sequential migrations passed")
