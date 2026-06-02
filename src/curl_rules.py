from __future__ import annotations

from dataclasses import dataclass, field
from statistics import pstdev


Point = tuple[float, float]


@dataclass
class CurlRulesConfig:
    extended_min_angle: float = 150.0
    extended_max_angle: float = 170.0
    flexed_min_angle: float = 40.0
    flexed_max_angle: float = 70.0
    min_partial_range_of_motion: float = 25.0
    min_range_of_motion: float = 80.0
    max_shoulder_shift_ratio: float = 0.35
    max_torso_shift_ratio: float = 0.30
    max_wrist_path_std_ratio: float = 0.22


@dataclass
class RepQuality:
    full_range_of_motion: bool = False
    shoulder_stable: bool = True
    torso_stable: bool = True
    wrist_path_consistent: bool = True

    @property
    def good_form(self) -> bool:
        return (
            self.full_range_of_motion
            and self.shoulder_stable
            and self.torso_stable
            and self.wrist_path_consistent
        )

    @property
    def warnings(self) -> list[str]:
        warnings: list[str] = []
        if not self.full_range_of_motion:
            warnings.append("range")
        if not self.shoulder_stable:
            warnings.append("shoulder")
        if not self.torso_stable:
            warnings.append("torso")
        if not self.wrist_path_consistent:
            warnings.append("wrist")
        return warnings


@dataclass
class CurlUpdate:
    counted_rep: bool = False
    current_rom: float = 0.0
    last_quality: RepQuality | None = None
    last_metrics: "RepMetrics | None" = None


@dataclass
class RepMetrics:
    attempt_number: int
    rep_number: int
    counted_rep: bool
    min_elbow_angle: float
    max_elbow_angle: float
    range_of_motion: float
    duration_seconds: float
    rep_speed_degrees_per_second: float
    shoulder_shift_ratio: float
    torso_shift_ratio: float
    wrist_path_std_ratio: float
    quality: RepQuality


@dataclass
class CurlTracker:
    config: CurlRulesConfig = field(default_factory=CurlRulesConfig)
    reps: int = 0
    attempts: int = 0
    phase: str = "waiting"
    min_angle: float = 180.0
    max_angle: float = 0.0
    start_time: float | None = None
    start_shoulder: Point | None = None
    start_torso: Point | None = None
    wrist_x_positions: list[float] = field(default_factory=list)
    last_quality: RepQuality | None = None

    def reset(self) -> None:
        self.reps = 0
        self.attempts = 0
        self.phase = "waiting"
        self._reset_rep_window()
        self.last_quality = None

    def update(self, sample: "CurlSample") -> CurlUpdate:
        angle = sample.elbow_angle
        counted_rep = False
        quality = None
        metrics = None

        if self._is_extended(angle) and self.phase in {"waiting", "complete"}:
            self.phase = "extended"
            self._start_rep_window(sample)
        elif self.phase == "extended":
            self._track_rep_window(sample)
            if self._is_flexed(angle):
                self.phase = "flexed"
            elif angle < self.config.extended_min_angle:
                self.phase = "moving"
        elif self.phase == "moving":
            self._track_rep_window(sample)
            if self._is_flexed(angle):
                self.phase = "flexed"
            elif self._is_extended(angle) and self._current_range_of_motion() >= self.config.min_partial_range_of_motion:
                self.attempts += 1
                metrics = self._score_rep(sample, force_partial=True)
                quality = metrics.quality
                self.last_quality = quality
                self.phase = "complete"
        elif self.phase == "flexed":
            self._track_rep_window(sample)
            if self._is_extended(angle):
                self.attempts += 1
                metrics = self._score_rep(sample)
                quality = metrics.quality
                self.last_quality = quality
                if quality.full_range_of_motion:
                    self.reps += 1
                    metrics.rep_number = self.reps
                    metrics.counted_rep = True
                    counted_rep = True
                self.phase = "complete"

        return CurlUpdate(
            counted_rep=counted_rep,
            current_rom=self.max_angle - self.min_angle,
            last_quality=quality,
            last_metrics=metrics,
        )

    def _is_extended(self, angle: float) -> bool:
        return self.config.extended_min_angle <= angle <= self.config.extended_max_angle

    def _is_flexed(self, angle: float) -> bool:
        return self.config.flexed_min_angle <= angle <= self.config.flexed_max_angle

    def _current_range_of_motion(self) -> float:
        return self.max_angle - self.min_angle

    def _start_rep_window(self, sample: "CurlSample") -> None:
        self.min_angle = sample.elbow_angle
        self.max_angle = sample.elbow_angle
        self.start_time = sample.timestamp_seconds
        self.start_shoulder = sample.shoulder
        self.start_torso = sample.torso_center
        self.wrist_x_positions = [sample.wrist[0]]

    def _track_rep_window(self, sample: "CurlSample") -> None:
        self.min_angle = min(self.min_angle, sample.elbow_angle)
        self.max_angle = max(self.max_angle, sample.elbow_angle)
        self.wrist_x_positions.append(sample.wrist[0])

    def _reset_rep_window(self) -> None:
        self.min_angle = 180.0
        self.max_angle = 0.0
        self.start_time = None
        self.start_shoulder = None
        self.start_torso = None
        self.wrist_x_positions = []

    def _score_rep(self, sample: "CurlSample", force_partial: bool = False) -> RepMetrics:
        scale = max(sample.upper_arm_length, 1.0)
        shoulder_shift = distance(self.start_shoulder, sample.shoulder) / scale if self.start_shoulder else 0.0
        torso_shift = distance(self.start_torso, sample.torso_center) / scale if self.start_torso else 0.0
        wrist_path_std = pstdev(self.wrist_x_positions) / scale if len(self.wrist_x_positions) > 1 else 0.0
        range_of_motion = self.max_angle - self.min_angle
        duration_seconds = max(sample.timestamp_seconds - self.start_time, 0.001) if self.start_time is not None else 0.001

        quality = RepQuality(
            full_range_of_motion=(not force_partial) and range_of_motion >= self.config.min_range_of_motion,
            shoulder_stable=shoulder_shift <= self.config.max_shoulder_shift_ratio,
            torso_stable=torso_shift <= self.config.max_torso_shift_ratio,
            wrist_path_consistent=wrist_path_std <= self.config.max_wrist_path_std_ratio,
        )
        return RepMetrics(
            attempt_number=self.attempts,
            rep_number=self.reps,
            counted_rep=False,
            min_elbow_angle=self.min_angle,
            max_elbow_angle=self.max_angle,
            range_of_motion=range_of_motion,
            duration_seconds=duration_seconds,
            rep_speed_degrees_per_second=range_of_motion / duration_seconds,
            shoulder_shift_ratio=shoulder_shift,
            torso_shift_ratio=torso_shift,
            wrist_path_std_ratio=wrist_path_std,
            quality=quality,
        )


@dataclass
class CurlSample:
    elbow_angle: float
    shoulder: Point
    elbow: Point
    wrist: Point
    torso_center: Point
    timestamp_seconds: float

    @property
    def upper_arm_length(self) -> float:
        return distance(self.shoulder, self.elbow)


def midpoint(a: Point, b: Point) -> Point:
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


def distance(a: Point | None, b: Point | None) -> float:
    if a is None or b is None:
        return 0.0
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
