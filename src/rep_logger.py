from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from curl_rules import RepMetrics


FIELDNAMES = [
    "timestamp_utc",
    "session_id",
    "label",
    "arm",
    "attempt_number",
    "rep_number",
    "counted_rep",
    "min_elbow_angle",
    "max_elbow_angle",
    "range_of_motion",
    "duration_seconds",
    "rep_speed_degrees_per_second",
    "shoulder_shift_ratio",
    "torso_shift_ratio",
    "wrist_path_std_ratio",
    "good_form",
    "warnings",
    "effort_score",
    "fatigue_level",
    "failure_risk",
    "estimated_reps_in_reserve",
    "recommended_reps_remaining",
    "recommendation",
]


@dataclass
class RepLogger:
    session_id: str
    label: str
    path: Path

    def log(self, metrics: RepMetrics, arm: str, coach_rep=None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ensure_schema()
        write_header = not self.path.exists()

        with self.path.open("a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
            if write_header:
                writer.writeheader()
            row = {
                "timestamp_utc": datetime.now(timezone.utc).isoformat(),
                "session_id": self.session_id,
                "label": self.label,
                "arm": arm,
                "attempt_number": metrics.attempt_number,
                "rep_number": metrics.rep_number,
                "counted_rep": metrics.counted_rep,
                "min_elbow_angle": round(metrics.min_elbow_angle, 2),
                "max_elbow_angle": round(metrics.max_elbow_angle, 2),
                "range_of_motion": round(metrics.range_of_motion, 2),
                "duration_seconds": round(metrics.duration_seconds, 3),
                "rep_speed_degrees_per_second": round(metrics.rep_speed_degrees_per_second, 2),
                "shoulder_shift_ratio": round(metrics.shoulder_shift_ratio, 4),
                "torso_shift_ratio": round(metrics.torso_shift_ratio, 4),
                "wrist_path_std_ratio": round(metrics.wrist_path_std_ratio, 4),
                "good_form": metrics.quality.good_form,
                "warnings": "|".join(metrics.quality.warnings),
                "effort_score": "",
                "fatigue_level": "",
                "failure_risk": "",
                "estimated_reps_in_reserve": "",
                "recommended_reps_remaining": "",
                "recommendation": "",
            }
            if coach_rep:
                row.update(
                    {
                        "effort_score": coach_rep.effort_score,
                        "fatigue_level": coach_rep.fatigue_level,
                        "failure_risk": coach_rep.failure_risk,
                        "estimated_reps_in_reserve": coach_rep.estimated_reps_in_reserve,
                        "recommended_reps_remaining": coach_rep.recommended_reps_remaining,
                        "recommendation": coach_rep.recommendation,
                    }
                )
            writer.writerow(row)

    def _ensure_schema(self) -> None:
        if not self.path.exists():
            return

        with self.path.open("r", newline="", encoding="utf-8-sig") as file:
            reader = csv.DictReader(file)
            existing_fieldnames = reader.fieldnames or []
            if all(field in existing_fieldnames for field in FIELDNAMES):
                return
            rows = list(reader)

        with self.path.open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=FIELDNAMES)
            writer.writeheader()
            for row in rows:
                writer.writerow({field: row.get(field, "") for field in FIELDNAMES})
