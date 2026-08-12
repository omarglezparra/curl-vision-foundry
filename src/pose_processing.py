from __future__ import annotations

from pathlib import Path
from typing import Literal
from urllib.request import urlretrieve

from mediapipe.tasks.python.vision import PoseLandmark
import numpy as np


ArmSide = Literal["left", "right"]
POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)


def calculate_angle(
    a: tuple[float, float],
    b: tuple[float, float],
    c: tuple[float, float],
) -> float:
    first = np.array(a)
    middle = np.array(b)
    last = np.array(c)
    radians = np.arctan2(last[1] - middle[1], last[0] - middle[0]) - np.arctan2(
        first[1] - middle[1],
        first[0] - middle[0],
    )
    angle = abs(radians * 180.0 / np.pi)
    return 360.0 - angle if angle > 180.0 else angle


def get_body_points(
    landmarks,
    side: ArmSide,
    width: int,
    height: int,
) -> dict[str, tuple[int, int]]:
    prefix = side.upper()
    shoulder = landmarks[getattr(PoseLandmark, f"{prefix}_SHOULDER").value]
    elbow = landmarks[getattr(PoseLandmark, f"{prefix}_ELBOW").value]
    wrist = landmarks[getattr(PoseLandmark, f"{prefix}_WRIST").value]
    left_hip = landmarks[PoseLandmark.LEFT_HIP.value]
    right_hip = landmarks[PoseLandmark.RIGHT_HIP.value]
    return {
        "shoulder": (int(shoulder.x * width), int(shoulder.y * height)),
        "elbow": (int(elbow.x * width), int(elbow.y * height)),
        "wrist": (int(wrist.x * width), int(wrist.y * height)),
        "left_hip": (int(left_hip.x * width), int(left_hip.y * height)),
        "right_hip": (int(right_hip.x * width), int(right_hip.y * height)),
    }


def arm_visibility(landmarks, side: ArmSide) -> float:
    prefix = side.upper()
    indexes = [
        getattr(PoseLandmark, f"{prefix}_SHOULDER").value,
        getattr(PoseLandmark, f"{prefix}_ELBOW").value,
        getattr(PoseLandmark, f"{prefix}_WRIST").value,
    ]
    return min(landmarks[index].visibility for index in indexes)


def choose_arm(landmarks, requested: str) -> ArmSide:
    if requested in {"left", "right"}:
        return requested
    return (
        "left"
        if arm_visibility(landmarks, "left") >= arm_visibility(landmarks, "right")
        else "right"
    )


def ensure_pose_model(model_path: str) -> str:
    path = Path(model_path)
    if path.exists():
        return str(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading MediaPipe pose model to {path}...")
    urlretrieve(POSE_MODEL_URL, path)
    return str(path)
