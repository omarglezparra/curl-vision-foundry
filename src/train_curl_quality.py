from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from typing import Any, Iterable

import cv2
import mediapipe as mp
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import (
    PoseLandmark,
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import StandardScaler

from pose_processing import calculate_angle, ensure_pose_model


FEATURE_NAMES = [
    "upper_arm_tilt_p90_deg",
    "upper_arm_drift_p90_deg",
    "torso_tilt_p90_deg",
    "torso_lean_change_p90_deg",
    "body_shift_p90_ratio",
    "shoulder_shift_p90_ratio",
    "shoulder_lift_p90_ratio",
    "elbow_offset_p90_ratio",
    "elbow_offset_change_p90_ratio",
    "neck_shorten_p90_ratio",
]

ARM_INDEXES = {
    "left": {
        "shoulder": PoseLandmark.LEFT_SHOULDER.value,
        "elbow": PoseLandmark.LEFT_ELBOW.value,
        "wrist": PoseLandmark.LEFT_WRIST.value,
        "hip": PoseLandmark.LEFT_HIP.value,
        "ear": PoseLandmark.LEFT_EAR.value,
    },
    "right": {
        "shoulder": PoseLandmark.RIGHT_SHOULDER.value,
        "elbow": PoseLandmark.RIGHT_ELBOW.value,
        "wrist": PoseLandmark.RIGHT_WRIST.value,
        "hip": PoseLandmark.RIGHT_HIP.value,
        "ear": PoseLandmark.RIGHT_EAR.value,
    },
}


@dataclass(frozen=True)
class PoseFrame:
    timestamp: float
    arm: str
    elbow_angle: float
    shoulder: np.ndarray
    elbow: np.ndarray
    wrist: np.ndarray
    same_hip: np.ndarray
    shoulder_center: np.ndarray
    hip_center: np.ndarray
    body_center: np.ndarray
    ear_center: np.ndarray | None
    torso_scale: float
    visibility: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train an explainable curl-form quality gate from labeled pose clips."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("training-videos/curl-training-segments/quality-labels.json"),
    )
    parser.add_argument(
        "--pose-model",
        default="outputs/models/pose_landmarker_lite.task",
    )
    parser.add_argument(
        "--model-output",
        type=Path,
        default=Path("docs/models/curl-quality-v1.json"),
    )
    parser.add_argument(
        "--report-dir",
        type=Path,
        default=Path("outputs/curl-quality-v1"),
    )
    parser.add_argument("--sample-fps", type=float, default=12.0)
    parser.add_argument("--window-seconds", type=float, default=1.4)
    parser.add_argument("--window-step-seconds", type=float, default=0.35)
    parser.add_argument("--seed", type=int, default=17)
    return parser.parse_args()


def point(landmark) -> np.ndarray:
    return np.array([float(landmark.x), float(landmark.y)], dtype=np.float64)


def midpoint(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    return (first + second) / 2.0


def distance(first: np.ndarray, second: np.ndarray) -> float:
    return float(np.linalg.norm(first - second))


def vector_angle_degrees(first: np.ndarray, second: np.ndarray) -> float:
    first_norm = float(np.linalg.norm(first))
    second_norm = float(np.linalg.norm(second))
    if first_norm < 1e-8 or second_norm < 1e-8:
        return 0.0
    cosine = float(np.dot(first, second) / (first_norm * second_norm))
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def landmark_visibility(landmark) -> float:
    visibility = getattr(landmark, "visibility", None)
    if visibility is None:
        visibility = getattr(landmark, "presence", 1.0)
    return float(visibility)


def pose_frame(landmarks: list[Any], arm: str, timestamp: float) -> PoseFrame | None:
    indexes = ARM_INDEXES[arm]
    left_shoulder = landmarks[PoseLandmark.LEFT_SHOULDER.value]
    right_shoulder = landmarks[PoseLandmark.RIGHT_SHOULDER.value]
    left_hip = landmarks[PoseLandmark.LEFT_HIP.value]
    right_hip = landmarks[PoseLandmark.RIGHT_HIP.value]
    shoulder_landmark = landmarks[indexes["shoulder"]]
    elbow_landmark = landmarks[indexes["elbow"]]
    wrist_landmark = landmarks[indexes["wrist"]]
    hip_landmark = landmarks[indexes["hip"]]

    required = [
        left_shoulder,
        right_shoulder,
        left_hip,
        right_hip,
        shoulder_landmark,
        elbow_landmark,
        wrist_landmark,
        hip_landmark,
    ]
    visibility = min(landmark_visibility(item) for item in required)
    if visibility < 0.35:
        return None

    shoulder = point(shoulder_landmark)
    elbow = point(elbow_landmark)
    wrist = point(wrist_landmark)
    same_hip = point(hip_landmark)
    shoulder_center = midpoint(point(left_shoulder), point(right_shoulder))
    hip_center = midpoint(point(left_hip), point(right_hip))
    torso_scale = max(distance(shoulder_center, hip_center), distance(point(left_shoulder), point(right_shoulder)), 0.05)

    left_ear = landmarks[PoseLandmark.LEFT_EAR.value]
    right_ear = landmarks[PoseLandmark.RIGHT_EAR.value]
    ear_center = None
    if min(landmark_visibility(left_ear), landmark_visibility(right_ear)) >= 0.35:
        ear_center = midpoint(point(left_ear), point(right_ear))

    return PoseFrame(
        timestamp=timestamp,
        arm=arm,
        elbow_angle=calculate_angle(tuple(shoulder), tuple(elbow), tuple(wrist)),
        shoulder=shoulder,
        elbow=elbow,
        wrist=wrist,
        same_hip=same_hip,
        shoulder_center=shoulder_center,
        hip_center=hip_center,
        body_center=midpoint(shoulder_center, hip_center),
        ear_center=ear_center,
        torso_scale=torso_scale,
        visibility=visibility,
    )


def crop_frame(frame: np.ndarray, crop: dict[str, float]) -> np.ndarray:
    height, width = frame.shape[:2]
    x1 = int(width * float(crop.get("x_min_ratio", 0.0)))
    x2 = int(width * float(crop.get("x_max_ratio", 1.0)))
    y1 = int(height * float(crop.get("y_min_ratio", 0.0)))
    y2 = int(height * float(crop.get("y_max_ratio", 1.0)))
    x1 = max(0, min(x1, width - 1))
    x2 = max(x1 + 1, min(x2, width))
    y1 = max(0, min(y1, height - 1))
    y2 = max(y1 + 1, min(y2, height))
    return frame[y1:y2, x1:x2]


def interval_at(intervals: list[dict[str, Any]], timestamp: float) -> tuple[int, dict[str, Any]] | None:
    for index, interval in enumerate(intervals):
        if float(interval["start"]) <= timestamp <= float(interval["end"]):
            return index, interval
    return None


def pose_options(model_path: str) -> PoseLandmarkerOptions:
    return PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.45,
        min_pose_presence_confidence=0.45,
        min_tracking_confidence=0.45,
    )


def extract_video_frames(
    video_path: Path,
    video_spec: dict[str, Any],
    crop: dict[str, float],
    model_path: str,
    sample_fps: float,
) -> tuple[dict[tuple[int, str], list[PoseFrame]], dict[str, Any]]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open {video_path}")

    source_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
    stride = max(1, int(round(source_fps / sample_fps)))
    frames_by_interval: dict[tuple[int, str], list[PoseFrame]] = defaultdict(list)
    processed = 0
    pose_frames = 0
    labeled_frames = 0
    frame_number = -1

    try:
        with PoseLandmarker.create_from_options(pose_options(model_path)) as landmarker:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frame_number += 1
                if frame_number % stride:
                    continue

                timestamp = frame_number / source_fps
                matched = interval_at(video_spec["intervals"], timestamp)
                if matched is None:
                    continue
                interval_index, _ = matched
                labeled_frames += 1
                frame = crop_frame(frame, crop)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                timestamp_ms = int(round(timestamp * 1000))
                result = landmarker.detect_for_video(mp_image, timestamp_ms)
                processed += 1
                if not result.pose_landmarks:
                    continue
                pose_frames += 1
                landmarks = result.pose_landmarks[0]
                for arm in ("left", "right"):
                    sample = pose_frame(landmarks, arm, timestamp)
                    if sample is not None:
                        frames_by_interval[(interval_index, arm)].append(sample)
    finally:
        cap.release()

    diagnostics = {
        "file": video_path.name,
        "source_fps": source_fps,
        "sample_stride": stride,
        "labeled_frames": labeled_frames,
        "processed_frames": processed,
        "frames_with_pose": pose_frames,
        "pose_detection_rate": round(pose_frames / processed, 4) if processed else 0.0,
    }
    return frames_by_interval, diagnostics


def percentile(values: Iterable[float], quantile: float) -> float:
    values = list(values)
    if not values:
        return 0.0
    return float(np.quantile(np.asarray(values, dtype=np.float64), quantile))


def feature_vector(frames: list[PoseFrame]) -> dict[str, float]:
    if len(frames) < 2:
        raise ValueError("At least two pose frames are required")

    baseline_count = min(3, len(frames))
    baseline_frames = frames[:baseline_count]
    baseline_shoulder = np.mean([item.shoulder for item in baseline_frames], axis=0)
    baseline_body = np.mean([item.body_center for item in baseline_frames], axis=0)
    baseline_upper = np.mean([item.elbow - item.shoulder for item in baseline_frames], axis=0)
    baseline_torso = np.mean([item.shoulder_center - item.hip_center for item in baseline_frames], axis=0)
    baseline_shoulder_hip = float(np.mean([item.same_hip[1] - item.shoulder[1] for item in baseline_frames]))
    baseline_elbow_offset = float(np.mean([abs(item.elbow[0] - item.shoulder[0]) / item.torso_scale for item in baseline_frames]))
    baseline_neck_ratio_values = [
        distance(item.shoulder_center, item.ear_center) / item.torso_scale
        for item in baseline_frames
        if item.ear_center is not None
    ]
    baseline_neck_ratio = float(np.mean(baseline_neck_ratio_values)) if baseline_neck_ratio_values else None

    vertical_down = np.array([0.0, 1.0], dtype=np.float64)
    vertical_up = np.array([0.0, -1.0], dtype=np.float64)
    upper_arm_tilt: list[float] = []
    upper_arm_drift: list[float] = []
    torso_tilt: list[float] = []
    torso_change: list[float] = []
    body_shift: list[float] = []
    shoulder_shift: list[float] = []
    shoulder_lift: list[float] = []
    elbow_offset: list[float] = []
    elbow_offset_change: list[float] = []
    neck_shorten: list[float] = []

    for item in frames:
        scale = max(item.torso_scale, 0.05)
        upper = item.elbow - item.shoulder
        torso = item.shoulder_center - item.hip_center
        offset = abs(item.elbow[0] - item.shoulder[0]) / scale
        upper_arm_tilt.append(vector_angle_degrees(upper, vertical_down))
        upper_arm_drift.append(vector_angle_degrees(upper, baseline_upper))
        torso_tilt.append(vector_angle_degrees(torso, vertical_up))
        torso_change.append(vector_angle_degrees(torso, baseline_torso))
        body_shift.append(distance(item.body_center, baseline_body) / scale)
        shoulder_shift.append(distance(item.shoulder, baseline_shoulder) / scale)
        shoulder_lift.append(abs((item.same_hip[1] - item.shoulder[1]) - baseline_shoulder_hip) / scale)
        elbow_offset.append(offset)
        elbow_offset_change.append(abs(offset - baseline_elbow_offset))
        if baseline_neck_ratio is not None and item.ear_center is not None:
            neck_ratio = distance(item.shoulder_center, item.ear_center) / scale
            neck_shorten.append(max(0.0, baseline_neck_ratio - neck_ratio))

    return {
        "upper_arm_tilt_p90_deg": percentile(upper_arm_tilt, 0.90),
        "upper_arm_drift_p90_deg": percentile(upper_arm_drift, 0.90),
        "torso_tilt_p90_deg": percentile(torso_tilt, 0.90),
        "torso_lean_change_p90_deg": percentile(torso_change, 0.90),
        "body_shift_p90_ratio": percentile(body_shift, 0.90),
        "shoulder_shift_p90_ratio": percentile(shoulder_shift, 0.90),
        "shoulder_lift_p90_ratio": percentile(shoulder_lift, 0.90),
        "elbow_offset_p90_ratio": percentile(elbow_offset, 0.90),
        "elbow_offset_change_p90_ratio": percentile(elbow_offset_change, 0.90),
        "neck_shorten_p90_ratio": percentile(neck_shorten, 0.90),
    }


def split_contiguous(frames: list[PoseFrame], max_gap: float = 0.3) -> list[list[PoseFrame]]:
    if not frames:
        return []
    chunks: list[list[PoseFrame]] = [[frames[0]]]
    for frame in frames[1:]:
        if frame.timestamp - chunks[-1][-1].timestamp > max_gap:
            chunks.append([frame])
        else:
            chunks[-1].append(frame)
    return chunks


def build_windows(
    frames: list[PoseFrame],
    window_seconds: float,
    step_seconds: float,
) -> list[list[PoseFrame]]:
    windows: list[list[PoseFrame]] = []
    for chunk in split_contiguous(frames):
        if len(chunk) < 8 or chunk[-1].timestamp - chunk[0].timestamp < 0.75:
            continue
        start = chunk[0].timestamp
        last_start = chunk[-1].timestamp - 0.75
        while start <= last_start + 1e-6:
            current = [item for item in chunk if start <= item.timestamp <= start + window_seconds]
            if len(current) >= 8 and current[-1].timestamp - current[0].timestamp >= 0.75:
                windows.append(current)
            start += step_seconds
    return windows


def extract_attempts(frames: list[PoseFrame]) -> list[list[PoseFrame]]:
    attempts: list[list[PoseFrame]] = []
    ready: PoseFrame | None = None
    active: list[PoseFrame] | None = None
    start_angle = 0.0
    min_angle = 180.0
    smoothed_angle: float | None = None
    previous_smoothed: float | None = None

    for frame in frames:
        smoothed_angle = frame.elbow_angle if smoothed_angle is None else smoothed_angle * 0.68 + frame.elbow_angle * 0.32
        if active is None:
            if smoothed_angle >= 120.0:
                ready = frame
                start_angle = smoothed_angle
            elif ready is not None and smoothed_angle <= start_angle - 8.0:
                active = [ready, frame]
                min_angle = smoothed_angle
        else:
            active.append(frame)
            min_angle = min(min_angle, smoothed_angle)
            duration = frame.timestamp - active[0].timestamp
            enough_flexion = start_angle - min_angle >= 30.0
            returning_down = previous_smoothed is not None and smoothed_angle > previous_smoothed
            near_start = smoothed_angle >= max(120.0, start_angle - 12.0)
            if enough_flexion and returning_down and near_start and duration >= 0.6:
                attempts.append(active)
                ready = frame
                active = None
                start_angle = smoothed_angle
                min_angle = 180.0
            elif duration > 8.0:
                active = None
                ready = frame if smoothed_angle >= 120.0 else None
                min_angle = 180.0
        previous_smoothed = smoothed_angle
    return attempts


def model_matrix(rows: list[dict[str, Any]]) -> np.ndarray:
    return np.asarray([[float(row[name]) for name in FEATURE_NAMES] for row in rows], dtype=np.float64)


def choose_threshold(y_true: np.ndarray, probabilities: np.ndarray) -> tuple[float, dict[str, float]]:
    candidates: list[tuple[float, float, float, float]] = []
    for threshold in np.arange(0.25, 0.811, 0.01):
        predicted = (probabilities >= threshold).astype(int)
        good_recall = recall_score(y_true, predicted, pos_label=1, zero_division=0)
        bad_recall = recall_score(y_true, predicted, pos_label=0, zero_division=0)
        balanced = balanced_accuracy_score(y_true, predicted)
        candidates.append((float(threshold), float(good_recall), float(bad_recall), float(balanced)))

    viable = [item for item in candidates if item[1] >= 0.80]
    pool = viable or candidates
    threshold, good_recall, bad_recall, balanced = max(pool, key=lambda item: (item[2], item[3], item[1]))
    return threshold, {
        "good_recall": round(good_recall, 4),
        "bad_rejection_rate": round(bad_recall, 4),
        "balanced_accuracy": round(balanced, 4),
    }


def grouped_cross_validation(
    rows: list[dict[str, Any]],
    seed: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, dict[str, Any]]:
    x = model_matrix(rows)
    y = np.asarray([1 if row["label"] == "good" else 0 for row in rows], dtype=np.int64)
    groups = np.asarray([row["video"] for row in rows])
    unique_groups = sorted(set(groups))
    splits = min(5, len(unique_groups))
    if splits < 2:
        raise RuntimeError("At least two source videos are required for grouped evaluation")

    probabilities = np.zeros(len(rows), dtype=np.float64)
    fold_indexes = np.full(len(rows), -1, dtype=np.int64)
    group_kfold = GroupKFold(n_splits=splits)
    for fold, (train_indexes, test_indexes) in enumerate(group_kfold.split(x, y, groups), start=1):
        if len(np.unique(y[train_indexes])) < 2:
            raise RuntimeError(f"Fold {fold} has only one training class; add more labeled source videos")
        scaler = StandardScaler().fit(x[train_indexes])
        classifier = LogisticRegression(
            class_weight="balanced",
            C=0.65,
            max_iter=2000,
            random_state=seed,
        )
        classifier.fit(scaler.transform(x[train_indexes]), y[train_indexes])
        probabilities[test_indexes] = classifier.predict_proba(scaler.transform(x[test_indexes]))[:, 1]
        fold_indexes[test_indexes] = fold

    threshold, threshold_metrics = choose_threshold(y, probabilities)
    predicted = (probabilities >= threshold).astype(int)
    matrix = confusion_matrix(y, predicted, labels=[0, 1])
    evaluation = {
        "split_strategy": f"GroupKFold({splits}) by complete source video",
        "threshold_selection": "Maximize bad-form rejection while retaining at least 80% grouped-CV good-form recall.",
        "good_probability_threshold": round(threshold, 4),
        "accuracy": round(accuracy_score(y, predicted), 4),
        "balanced_accuracy": round(balanced_accuracy_score(y, predicted), 4),
        "good_precision": round(precision_score(y, predicted, pos_label=1, zero_division=0), 4),
        "good_recall": round(recall_score(y, predicted, pos_label=1, zero_division=0), 4),
        "bad_rejection_rate": round(recall_score(y, predicted, pos_label=0, zero_division=0), 4),
        "roc_auc": round(roc_auc_score(y, probabilities), 4),
        "confusion_matrix_labels_bad_good": matrix.tolist(),
        "threshold_metrics": threshold_metrics,
        "per_video": {},
    }
    for group in unique_groups:
        mask = groups == group
        group_y = y[mask]
        group_predicted = predicted[mask]
        evaluation["per_video"][str(group)] = {
            "windows": int(mask.sum()),
            "good_windows": int(group_y.sum()),
            "bad_windows": int((group_y == 0).sum()),
            "accuracy": round(accuracy_score(group_y, group_predicted), 4),
        }
    return x, y, probabilities, threshold, evaluation


def clamp(value: float, minimum: float, maximum: float) -> float:
    return float(max(minimum, min(value, maximum)))


def learned_counting_thresholds(
    attempt_rows: list[dict[str, Any]],
    window_rows: list[dict[str, Any]],
) -> dict[str, float]:
    good_attempts = [row for row in attempt_rows if row["label"] == "good"]
    good_windows = [row for row in window_rows if row["label"] == "good"]

    if good_attempts:
        down_angle = clamp(percentile((row["max_elbow_angle"] for row in good_attempts), 0.05), 125.0, 145.0)
        up_angle = clamp(percentile((row["min_elbow_angle"] for row in good_attempts), 0.85), 72.0, 102.0)
        min_rom = clamp(percentile((row["range_of_motion"] for row in good_attempts), 0.05), 60.0, 82.0)
    else:
        down_angle, up_angle, min_rom = 142.0, 92.0, 65.0

    def good_limit(feature: str, quantile: float, margin: float, minimum: float, maximum: float) -> float:
        values = [float(row[feature]) for row in good_windows]
        learned = percentile(values, quantile) + margin if values else minimum
        return round(clamp(learned, minimum, maximum), 4)

    return {
        "down_angle_deg": round(down_angle, 2),
        "up_angle_deg": round(up_angle, 2),
        "minimum_range_of_motion_deg": round(min_rom, 2),
        "minimum_rep_seconds": 0.8,
        "maximum_rep_seconds": 8.0,
        "minimum_visibility": 0.48,
        "maximum_upper_arm_tilt_p90_deg": good_limit("upper_arm_tilt_p90_deg", 0.975, 5.0, 30.0, 58.0),
        "maximum_upper_arm_drift_p90_deg": good_limit("upper_arm_drift_p90_deg", 0.975, 4.0, 18.0, 42.0),
        "maximum_torso_lean_change_p90_deg": good_limit("torso_lean_change_p90_deg", 0.975, 3.0, 10.0, 28.0),
        "maximum_body_shift_p90_ratio": good_limit("body_shift_p90_ratio", 0.975, 0.04, 0.14, 0.48),
        "maximum_shoulder_lift_p90_ratio": good_limit("shoulder_lift_p90_ratio", 0.975, 0.03, 0.10, 0.32),
    }


def probability_for(
    row: dict[str, Any],
    scaler: StandardScaler,
    classifier: LogisticRegression,
) -> float:
    vector = np.asarray([[float(row[name]) for name in FEATURE_NAMES]], dtype=np.float64)
    return float(classifier.predict_proba(scaler.transform(vector))[0, 1])


def runtime_rejection_reason(
    row: dict[str, Any],
    counting: dict[str, float],
    probability_threshold: float,
) -> str:
    if (
        float(row["max_elbow_angle"]) < counting["down_angle_deg"]
        or float(row["min_elbow_angle"]) > counting["up_angle_deg"]
        or float(row["range_of_motion"]) < counting["minimum_range_of_motion_deg"]
    ):
        return "range"
    if (
        float(row["upper_arm_tilt_p90_deg"]) > counting["maximum_upper_arm_tilt_p90_deg"]
        or float(row["upper_arm_drift_p90_deg"]) > counting["maximum_upper_arm_drift_p90_deg"]
    ):
        return "elbow"
    if (
        float(row["torso_lean_change_p90_deg"]) > counting["maximum_torso_lean_change_p90_deg"]
        or float(row["body_shift_p90_ratio"]) > counting["maximum_body_shift_p90_ratio"]
    ):
        return "torso"
    if float(row["shoulder_lift_p90_ratio"]) > counting["maximum_shoulder_lift_p90_ratio"]:
        return "shoulder"
    if not counting["minimum_rep_seconds"] <= float(row["duration_seconds"]) <= counting["maximum_rep_seconds"]:
        return "speed"
    if float(row["model_good_probability"]) < probability_threshold:
        return "model"
    return "accepted"


def main() -> int:
    args = parse_args()
    manifest_path = args.manifest.resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    video_dir = manifest_path.parent
    model_path = ensure_pose_model(args.pose_model)
    all_interval_frames: dict[tuple[str, int, str], list[PoseFrame]] = {}
    extraction_diagnostics: list[dict[str, Any]] = []

    print(f"Loading {len(manifest['videos'])} labeled source videos from {video_dir}")
    for index, video_spec in enumerate(manifest["videos"], start=1):
        video_path = video_dir / video_spec["file"]
        if not video_path.exists():
            raise FileNotFoundError(video_path)
        print(f"[{index}/{len(manifest['videos'])}] Extracting poses: {video_path.name}", flush=True)
        frames_by_interval, diagnostics = extract_video_frames(
            video_path,
            video_spec,
            manifest.get("crop", {}),
            model_path,
            args.sample_fps,
        )
        extraction_diagnostics.append(diagnostics)
        for (interval_index, arm), frames in frames_by_interval.items():
            all_interval_frames[(video_path.name, interval_index, arm)] = frames
        print(
            f"    pose detection {diagnostics['pose_detection_rate']:.1%} "
            f"({diagnostics['frames_with_pose']}/{diagnostics['processed_frames']})",
            flush=True,
        )

    window_rows: list[dict[str, Any]] = []
    attempt_rows: list[dict[str, Any]] = []
    video_specs = {spec["file"]: spec for spec in manifest["videos"]}
    for (video, interval_index, arm), frames in sorted(all_interval_frames.items()):
        interval = video_specs[video]["intervals"][interval_index]
        label = interval["label"]
        error = interval.get("error") or ""
        for window_index, window in enumerate(
            build_windows(frames, args.window_seconds, args.window_step_seconds),
            start=1,
        ):
            row: dict[str, Any] = {
                "video": video,
                "interval": interval_index,
                "arm": arm,
                "window": window_index,
                "start_seconds": round(window[0].timestamp, 3),
                "end_seconds": round(window[-1].timestamp, 3),
                "label": label,
                "error": error,
                "frames": len(window),
                "mean_visibility": round(float(np.mean([item.visibility for item in window])), 6),
            }
            row.update(feature_vector(window))
            window_rows.append(row)

        for attempt_index, attempt in enumerate(extract_attempts(frames), start=1):
            row = {
                "video": video,
                "interval": interval_index,
                "arm": arm,
                "attempt": attempt_index,
                "start_seconds": round(attempt[0].timestamp, 3),
                "end_seconds": round(attempt[-1].timestamp, 3),
                "label": label,
                "error": error,
                "frames": len(attempt),
                "duration_seconds": round(attempt[-1].timestamp - attempt[0].timestamp, 4),
                "min_elbow_angle": round(min(item.elbow_angle for item in attempt), 4),
                "max_elbow_angle": round(max(item.elbow_angle for item in attempt), 4),
                "range_of_motion": round(
                    max(item.elbow_angle for item in attempt) - min(item.elbow_angle for item in attempt),
                    4,
                ),
                "mean_visibility": round(float(np.mean([item.visibility for item in attempt])), 6),
            }
            row.update(feature_vector(attempt))
            attempt_rows.append(row)

    class_counts = Counter(row["label"] for row in window_rows)
    if class_counts["good"] < 10 or class_counts["bad"] < 10:
        raise RuntimeError(f"Not enough labeled windows to train safely: {dict(class_counts)}")
    print(f"Built {len(window_rows)} pose windows: {dict(class_counts)}", flush=True)
    print(f"Detected {len(attempt_rows)} complete movement attempts for ROM calibration", flush=True)

    x, y, probabilities, probability_threshold, evaluation = grouped_cross_validation(window_rows, args.seed)
    deployment_eligible = (
        float(evaluation["roc_auc"]) >= 0.75
        and float(evaluation["good_recall"]) >= 0.80
        and float(evaluation["bad_rejection_rate"]) >= 0.65
    )
    evaluation["deployment_gate"] = {
        "eligible": deployment_eligible,
        "minimum_roc_auc": 0.75,
        "minimum_good_recall": 0.80,
        "minimum_bad_rejection_rate": 0.65,
    }
    if not deployment_eligible:
        raise RuntimeError(
            "Candidate model failed the deployment gate: "
            f"AUC={evaluation['roc_auc']}, good_recall={evaluation['good_recall']}, "
            f"bad_rejection={evaluation['bad_rejection_rate']}"
        )
    scaler = StandardScaler().fit(x)
    classifier = LogisticRegression(
        class_weight="balanced",
        C=0.65,
        max_iter=2000,
        random_state=args.seed,
    )
    classifier.fit(scaler.transform(x), y)
    counting = learned_counting_thresholds(attempt_rows, window_rows)

    for row, probability in zip(window_rows, probabilities):
        row["grouped_cv_good_probability"] = round(float(probability), 6)
        row["grouped_cv_prediction"] = "good" if probability >= probability_threshold else "bad"
    for row in attempt_rows:
        row["model_good_probability"] = round(probability_for(row, scaler, classifier), 6)
        row["runtime_result"] = runtime_rejection_reason(row, counting, probability_threshold)

    good_attempts = [row for row in attempt_rows if row["label"] == "good"]
    bad_attempts = [row for row in attempt_rows if row["label"] == "bad"]
    good_attempt_acceptance = (
        sum(row["runtime_result"] == "accepted" for row in good_attempts) / len(good_attempts)
        if good_attempts else 0.0
    )
    bad_attempt_rejection = (
        sum(row["runtime_result"] != "accepted" for row in bad_attempts) / len(bad_attempts)
        if bad_attempts else 0.0
    )
    evaluation["labeled_attempt_sanity_check"] = {
        "note": "Secondary in-sample full-attempt check; grouped-video window metrics remain the primary generalization estimate.",
        "good_attempts": len(good_attempts),
        "bad_attempts": len(bad_attempts),
        "good_attempt_acceptance": round(good_attempt_acceptance, 4),
        "bad_attempt_rejection": round(bad_attempt_rejection, 4),
        "result_counts": dict(Counter(row["runtime_result"] for row in attempt_rows)),
    }
    attempt_gate_passed = good_attempt_acceptance >= 0.80 and bad_attempt_rejection >= 0.75
    evaluation["deployment_gate"].update({
        "minimum_good_attempt_acceptance": 0.80,
        "minimum_bad_attempt_rejection": 0.75,
        "eligible": bool(evaluation["deployment_gate"]["eligible"] and attempt_gate_passed),
    })
    if not attempt_gate_passed:
        raise RuntimeError(
            "Candidate model failed the full-attempt sanity gate: "
            f"good_acceptance={good_attempt_acceptance:.4f}, bad_rejection={bad_attempt_rejection:.4f}"
        )

    generated_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    model = {
        "schema_version": 1,
        "model_id": "curl-quality-v1",
        "exercise": manifest["exercise"],
        "generated_at_utc": generated_at,
        "purpose": "Reject technically invalid curl attempts before incrementing the repetition counter and return one specific correction.",
        "pose_runtime": {
            "family": "MediaPipe Pose Landmarker",
            "landmarks": "normalized_2d",
            "training_sample_fps": args.sample_fps,
            "runtime_smoothing_alpha": 0.32,
        },
        "dataset": {
            "rights_status": manifest.get("rights_status", "unknown"),
            "video_count": len(manifest["videos"]),
            "source_videos": [spec["file"] for spec in manifest["videos"]],
            "labeled_interval_count": sum(len(spec["intervals"]) for spec in manifest["videos"]),
            "window_count": len(window_rows),
            "good_window_count": class_counts["good"],
            "bad_window_count": class_counts["bad"],
            "complete_attempt_count": len(attempt_rows),
            "annotation_method": manifest.get("annotation_method", ""),
        },
        "features": FEATURE_NAMES,
        "standard_scaler": {
            "mean": [round(float(value), 8) for value in scaler.mean_],
            "scale": [round(float(value), 8) for value in scaler.scale_],
        },
        "classifier": {
            "type": "binary_logistic_regression",
            "positive_class": "good",
            "coefficients": [round(float(value), 8) for value in classifier.coef_[0]],
            "intercept": round(float(classifier.intercept_[0]), 8),
            "good_probability_threshold": round(float(probability_threshold), 4),
        },
        "counting": counting,
        "evaluation": evaluation,
        "coaching": {
            "range": "Intento no contado: completa el recorrido; extiende abajo y flexiona arriba.",
            "elbow": "Intento no contado: fija el codo junto al costado; no lo lleves hacia delante.",
            "torso": "Intento no contado: evita el impulso y mantén el torso quieto.",
            "shoulder": "Intento no contado: baja los hombros y no los encojas al subir.",
            "speed": "Intento no contado: haz la repetición más lenta y controla la bajada.",
            "visibility": "Intento no contado: necesito ver hombro, codo, muñeca y cadera durante todo el recorrido.",
            "quality": "Intento no contado: repite con el torso quieto y el codo estable.",
        },
    }

    args.report_dir.mkdir(parents=True, exist_ok=True)
    args.model_output.parent.mkdir(parents=True, exist_ok=True)
    args.model_output.write_text(json.dumps(model, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pd.DataFrame(window_rows).to_csv(args.report_dir / "pose-windows.csv", index=False)
    pd.DataFrame(attempt_rows).to_csv(args.report_dir / "detected-attempts.csv", index=False)
    report = {
        "model_output": str(args.model_output),
        "generated_at_utc": generated_at,
        "dataset": model["dataset"],
        "extraction": extraction_diagnostics,
        "evaluation": evaluation,
        "counting": counting,
        "coefficient_by_feature": dict(zip(FEATURE_NAMES, model["classifier"]["coefficients"])),
    }
    (args.report_dir / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(json.dumps({"model": str(args.model_output), "evaluation": evaluation, "counting": counting}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
