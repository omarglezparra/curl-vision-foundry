from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


SRC_PATH = Path(__file__).resolve().parents[1] / "src"
if str(SRC_PATH) not in sys.path:
    sys.path.insert(0, str(SRC_PATH))

import process_azure_captures as PROCESSOR  # noqa: E402


class ProcessAzurePrivacyTests(unittest.TestCase):
    def test_tombstones_remove_old_and_legacy_rows_but_allow_new_captures(self) -> None:
        profile_id = "mp_" + "a" * 24
        other_profile = "mp_" + "b" * 24
        deleted_at = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
        rows = [
            {
                "profile_id": profile_id,
                "capture_id": "old",
                "capture_created_at_utc": "2026-07-30T11:59:00Z",
            },
            {
                "profile_id": profile_id,
                "capture_id": "legacy-without-time",
                "capture_created_at_utc": "",
            },
            {
                "profile_id": profile_id,
                "capture_id": "new",
                "capture_created_at_utc": "2026-07-30T12:01:00+00:00",
            },
            {
                "profile_id": other_profile,
                "capture_id": "other",
                "capture_created_at_utc": "2026-07-01T00:00:00Z",
            },
        ]

        filtered = PROCESSOR.filter_tombstoned_rows(rows, {profile_id: deleted_at})

        self.assertEqual([row["capture_id"] for row in filtered], ["new", "other"])

    def test_invalid_capture_timestamp_is_treated_as_legacy_for_deleted_profile(self) -> None:
        profile_id = "mp_" + "a" * 24
        deleted_at = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)

        filtered = PROCESSOR.filter_tombstoned_rows(
            [
                {
                    "profile_id": profile_id,
                    "capture_id": "invalid",
                    "capture_created_at_utc": "not-a-time",
                }
            ],
            {profile_id: deleted_at},
        )

        self.assertEqual(filtered, [])

    def test_incremental_merge_replaces_one_capture_without_duplicating_reps(self) -> None:
        existing_summaries = [
            {"profile_id": "owner", "session_id": "s1", "capture_id": "c1", "counted_reps": "2"},
            {"profile_id": "owner", "session_id": "s2", "capture_id": "c2", "counted_reps": "3"},
        ]
        existing_reps = [
            {
                "profile_id": "owner",
                "session_id": "s1",
                "capture_id": "c1",
                "arm": "left",
                "attempt_number": "1",
                "rep_number": "1",
            },
            {
                "profile_id": "owner",
                "session_id": "s2",
                "capture_id": "c2",
                "arm": "right",
                "attempt_number": "1",
                "rep_number": "1",
            },
        ]
        new_summary = {
            "profile_id": "owner",
            "session_id": "s1",
            "capture_id": "c1",
            "counted_reps": "0",
        }

        summaries, reps = PROCESSOR.merge_incremental_rows(
            existing_summaries,
            existing_reps,
            [new_summary],
            [],
        )

        self.assertEqual(len(summaries), 2)
        self.assertIn(new_summary, summaries)
        self.assertEqual([row["capture_id"] for row in reps], ["c2"])

    def test_row_level_retention_uses_capture_time_then_processed_time(self) -> None:
        now = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
        rows = [
            {
                "capture_id": "fresh",
                "capture_created_at_utc": "2026-07-30T12:00:00Z",
                "processed_at_utc": "2026-07-30T12:01:00Z",
            },
            {
                "capture_id": "fallback",
                "capture_created_at_utc": "",
                "processed_at_utc": "2026-07-31T11:00:00Z",
            },
            {
                "capture_id": "expired",
                "capture_created_at_utc": "2026-07-29T11:59:59Z",
                "processed_at_utc": "2026-07-31T11:00:00Z",
            },
            {
                "capture_id": "undated",
                "capture_created_at_utc": "",
                "processed_at_utc": "",
            },
        ]

        retained = PROCESSOR.filter_retained_rows(rows, 2, now=now)

        self.assertEqual(
            [row["capture_id"] for row in retained],
            ["fresh", "fallback"],
        )


if __name__ == "__main__":
    unittest.main()
