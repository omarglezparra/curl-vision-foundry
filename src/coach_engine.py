from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import mean

from curl_rules import RepMetrics


@dataclass
class UserProfile:
    baseline_rep_speed: float
    baseline_range_of_motion: float
    normal_shoulder_shift: float
    normal_torso_shift: float
    normal_wrist_path: float
    samples_used: int


@dataclass
class CoachRep:
    rep_number: int
    effort_score: float
    fatigue_level: str
    failure_risk: float
    estimated_reps_in_reserve: int
    recommended_reps_remaining: int
    speed_drop_percent: float
    range_drop_percent: float
    form_penalty: float
    recommendation: str


@dataclass
class LiveCoachState:
    session_speeds: list[float]
    session_ranges: list[float]


class LiveCoach:
    def __init__(self, profile: UserProfile) -> None:
        self.profile = profile
        self.state = LiveCoachState(session_speeds=[], session_ranges=[])

    def evaluate(self, metrics: RepMetrics) -> CoachRep:
        self.state.session_speeds.append(metrics.rep_speed_degrees_per_second)
        self.state.session_ranges.append(metrics.range_of_motion)

        first_speeds = self.state.session_speeds[: min(3, len(self.state.session_speeds))]
        first_ranges = self.state.session_ranges[: min(3, len(self.state.session_ranges))]
        session_speed = positive_average(first_speeds, fallback=self.profile.baseline_rep_speed)
        session_rom = positive_average(first_ranges, fallback=self.profile.baseline_range_of_motion)

        speed_baseline = max(mean([self.profile.baseline_rep_speed, session_speed]), 1.0)
        rom_baseline = max(mean([self.profile.baseline_range_of_motion, session_rom]), 1.0)
        shoulder_baseline = max(self.profile.normal_shoulder_shift, 0.01)
        torso_baseline = max(self.profile.normal_torso_shift, 0.01)
        wrist_baseline = max(self.profile.normal_wrist_path, 0.01)

        return score_rep_metrics(
            metrics=metrics,
            speed_baseline=speed_baseline,
            rom_baseline=rom_baseline,
            shoulder_baseline=shoulder_baseline,
            torso_baseline=torso_baseline,
            wrist_baseline=wrist_baseline,
        )


def parse_bool(value: str) -> bool:
    return value.strip().lower() == "true"


def parse_float(row: dict[str, str], field: str) -> float:
    try:
        return float(row[field])
    except (KeyError, TypeError, ValueError):
        return 0.0


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", newline="", encoding="utf-8-sig") as file:
        return list(csv.DictReader(file))


def positive_average(values: list[float], fallback: float) -> float:
    positive_values = [value for value in values if value > 0]
    return mean(positive_values) if positive_values else fallback


def build_user_profile(rows: list[dict[str, str]]) -> UserProfile:
    good_rows = [
        row
        for row in rows
        if row.get("label") == "good_form"
        and parse_bool(row.get("counted_rep", "False"))
        and parse_bool(row.get("good_form", "False"))
    ]

    if not good_rows:
        good_rows = [
            row
            for row in rows
            if parse_bool(row.get("counted_rep", "False"))
            and row.get("label") in {"good_form", "fatigue"}
        ]

    return UserProfile(
        baseline_rep_speed=positive_average(
            [parse_float(row, "rep_speed_degrees_per_second") for row in good_rows],
            fallback=45.0,
        ),
        baseline_range_of_motion=positive_average(
            [parse_float(row, "range_of_motion") for row in good_rows],
            fallback=110.0,
        ),
        normal_shoulder_shift=positive_average(
            [parse_float(row, "shoulder_shift_ratio") for row in good_rows],
            fallback=0.08,
        ),
        normal_torso_shift=positive_average(
            [parse_float(row, "torso_shift_ratio") for row in good_rows],
            fallback=0.08,
        ),
        normal_wrist_path=positive_average(
            [parse_float(row, "wrist_path_std_ratio") for row in good_rows],
            fallback=0.25,
        ),
        samples_used=len(good_rows),
    )


def clamp(value: float, minimum: float = 0.0, maximum: float = 100.0) -> float:
    return max(minimum, min(maximum, value))


def fatigue_level(effort_score: float) -> str:
    if effort_score >= 80:
        return "near_failure"
    if effort_score >= 60:
        return "high"
    if effort_score >= 35:
        return "medium"
    return "low"


def recommendation_for(effort_score: float, rir: int) -> str:
    if effort_score >= 85:
        return "stop_now"
    if effort_score >= 70:
        return "one_more_if_form_stays_clean"
    if effort_score >= 45:
        return f"{max(1, min(rir - 1, 3))}_controlled_reps"
    return f"{max(2, min(rir, 5))}_reps_available"


def estimate_reps_in_reserve(effort_score: float) -> int:
    if effort_score >= 90:
        return 0
    if effort_score >= 75:
        return 1
    if effort_score >= 60:
        return 2
    if effort_score >= 45:
        return 3
    if effort_score >= 30:
        return 4
    return 5


def score_rep_metrics(
    metrics: RepMetrics,
    speed_baseline: float,
    rom_baseline: float,
    shoulder_baseline: float,
    torso_baseline: float,
    wrist_baseline: float,
) -> CoachRep:
    speed_drop = clamp((1.0 - metrics.rep_speed_degrees_per_second / speed_baseline) * 100.0)
    rom_drop = clamp((1.0 - metrics.range_of_motion / rom_baseline) * 100.0)
    shoulder_penalty = clamp(((metrics.shoulder_shift_ratio / shoulder_baseline) - 1.0) * 18.0)
    torso_penalty = clamp(((metrics.torso_shift_ratio / torso_baseline) - 1.0) * 18.0)
    wrist_penalty = clamp(((metrics.wrist_path_std_ratio / wrist_baseline) - 1.0) * 8.0)
    form_penalty = clamp(shoulder_penalty + torso_penalty + wrist_penalty)

    effort = clamp((speed_drop * 0.55) + (rom_drop * 0.25) + (form_penalty * 0.20))
    rir = estimate_reps_in_reserve(effort)
    recommended = max(0, rir - 1)

    return CoachRep(
        rep_number=metrics.rep_number,
        effort_score=round(effort, 2),
        fatigue_level=fatigue_level(effort),
        failure_risk=round(clamp(effort * 1.05), 2),
        estimated_reps_in_reserve=rir,
        recommended_reps_remaining=recommended,
        speed_drop_percent=round(speed_drop, 2),
        range_drop_percent=round(rom_drop, 2),
        form_penalty=round(form_penalty, 2),
        recommendation=recommendation_for(effort, rir),
    )


def coach_message(rep: CoachRep) -> str:
    fatigue = {
        "low": "baja",
        "medium": "media",
        "high": "alta",
        "near_failure": "cerca del fallo",
    }.get(rep.fatigue_level, rep.fatigue_level)

    if rep.recommended_reps_remaining <= 0:
        return f"Repeticion {rep.rep_number}. Fatiga {fatigue}. Riesgo {rep.failure_risk:.0f} por ciento. Para aqui."
    return (
        f"Repeticion {rep.rep_number}. Fatiga {fatigue}. "
        f"Riesgo {rep.failure_risk:.0f} por ciento. "
        f"Haz {rep.recommended_reps_remaining} mas con control."
    )


def session_rows(rows: list[dict[str, str]], session_id: str) -> list[dict[str, str]]:
    return [
        row
        for row in rows
        if row.get("session_id") == session_id
        and parse_bool(row.get("counted_rep", "False"))
    ]


def analyze_session(rows: list[dict[str, str]], session_id: str, profile: UserProfile) -> dict[str, object]:
    reps = session_rows(rows, session_id)
    if not reps:
        raise ValueError(f"No counted reps found for session_id={session_id}")

    first_reps = reps[: min(3, len(reps))]
    session_speed = positive_average(
        [parse_float(row, "rep_speed_degrees_per_second") for row in first_reps],
        fallback=profile.baseline_rep_speed,
    )
    session_rom = positive_average(
        [parse_float(row, "range_of_motion") for row in first_reps],
        fallback=profile.baseline_range_of_motion,
    )

    speed_baseline = max(mean([profile.baseline_rep_speed, session_speed]), 1.0)
    rom_baseline = max(mean([profile.baseline_range_of_motion, session_rom]), 1.0)
    shoulder_baseline = max(profile.normal_shoulder_shift, 0.01)
    torso_baseline = max(profile.normal_torso_shift, 0.01)
    wrist_baseline = max(profile.normal_wrist_path, 0.01)

    coach_reps: list[CoachRep] = []
    for index, row in enumerate(reps, start=1):
        speed = parse_float(row, "rep_speed_degrees_per_second")
        rom = parse_float(row, "range_of_motion")
        shoulder = parse_float(row, "shoulder_shift_ratio")
        torso = parse_float(row, "torso_shift_ratio")
        wrist = parse_float(row, "wrist_path_std_ratio")

        coach_reps.append(
            score_rep_metrics(
                metrics=RepMetrics(
                    attempt_number=index,
                    rep_number=int(parse_float(row, "rep_number") or index),
                    counted_rep=True,
                    min_elbow_angle=parse_float(row, "min_elbow_angle"),
                    max_elbow_angle=parse_float(row, "max_elbow_angle"),
                    range_of_motion=rom,
                    duration_seconds=parse_float(row, "duration_seconds"),
                    rep_speed_degrees_per_second=speed,
                    shoulder_shift_ratio=shoulder,
                    torso_shift_ratio=torso,
                    wrist_path_std_ratio=wrist,
                    quality=None,
                ),
                speed_baseline=speed_baseline,
                rom_baseline=rom_baseline,
                shoulder_baseline=shoulder_baseline,
                torso_baseline=torso_baseline,
                wrist_baseline=wrist_baseline,
            )
        )

    latest = coach_reps[-1]
    return {
        "session_id": session_id,
        "profile": asdict(profile),
        "session_baseline": {
            "rep_speed": round(session_speed, 2),
            "range_of_motion": round(session_rom, 2),
        },
        "summary": {
            "reps_analyzed": len(reps),
            "latest_effort_score": latest.effort_score,
            "latest_fatigue_level": latest.fatigue_level,
            "latest_failure_risk": latest.failure_risk,
            "estimated_reps_in_reserve": latest.estimated_reps_in_reserve,
            "recommended_reps_remaining": latest.recommended_reps_remaining,
            "recommendation": latest.recommendation,
        },
        "reps": [asdict(rep) for rep in coach_reps],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze curl sessions and generate adaptive coach recommendations.")
    parser.add_argument("--csv", default="outputs/curl_reps.csv", help="Rep metrics CSV path.")
    parser.add_argument("--session", required=True, help="Session id to analyze.")
    parser.add_argument("--profile-output", default="outputs/user_profile.json", help="Where to write the user profile.")
    parser.add_argument("--report-output", default="", help="Where to write the coach report JSON.")
    args = parser.parse_args()

    rows = load_rows(Path(args.csv))
    profile = build_user_profile(rows)
    report = analyze_session(rows, args.session, profile)

    profile_path = Path(args.profile_output)
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(json.dumps(asdict(profile), indent=2), encoding="utf-8")

    report_path = Path(args.report_output or f"outputs/coach_report_{args.session}.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(json.dumps(report["summary"], indent=2))
    print(f"Profile written to {profile_path}")
    print(f"Report written to {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
