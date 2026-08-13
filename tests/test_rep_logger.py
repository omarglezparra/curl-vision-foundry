from __future__ import annotations

import csv
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from rep_logger import FIELDNAMES, RepLogger  # noqa: E402


class RepLoggerTests(unittest.TestCase):
    def test_export_session_keeps_only_selected_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "all-reps.csv"
            destination = Path(temp_dir) / "recording" / "reps.csv"
            with source.open("w", newline="", encoding="utf-8") as file:
                writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
                writer.writeheader()
                writer.writerow({"session_id": "wanted", "rep_number": "1"})
                writer.writerow({"session_id": "other", "rep_number": "2"})

            count = RepLogger("wanted", "unlabeled", source).export_session(destination)

            self.assertEqual(count, 1)
            with destination.open("r", newline="", encoding="utf-8") as file:
                rows = list(csv.DictReader(file))
            self.assertEqual([row["session_id"] for row in rows], ["wanted"])


if __name__ == "__main__":
    unittest.main()
