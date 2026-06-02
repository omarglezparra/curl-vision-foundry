from __future__ import annotations

import argparse
import time
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.request import urlretrieve

import cv2
import mediapipe as mp
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmark, PoseLandmarker, PoseLandmarkerOptions, RunningMode
import numpy as np

from coach_engine import LiveCoach, build_user_profile, coach_message, load_rows
from curl_rules import CurlSample, CurlTracker, midpoint
from rep_logger import RepLogger
from voice_coach import VoiceCoach


ArmSide = Literal["left", "right"]
POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)


def calculate_angle(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    first = np.array(a)
    middle = np.array(b)
    last = np.array(c)

    radians = np.arctan2(last[1] - middle[1], last[0] - middle[0]) - np.arctan2(
        first[1] - middle[1], first[0] - middle[0]
    )
    angle = abs(radians * 180.0 / np.pi)

    if angle > 180.0:
        angle = 360.0 - angle

    return angle


def get_body_points(landmarks, side: ArmSide, width: int, height: int) -> dict[str, tuple[int, int]]:
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


def torso_visibility(landmarks) -> float:
    indexes = [
        PoseLandmark.LEFT_SHOULDER.value,
        PoseLandmark.RIGHT_SHOULDER.value,
        PoseLandmark.LEFT_HIP.value,
        PoseLandmark.RIGHT_HIP.value,
    ]
    return min(landmarks[index].visibility for index in indexes)


def body_inside_frame(landmarks) -> bool:
    indexes = [
        PoseLandmark.LEFT_SHOULDER.value,
        PoseLandmark.RIGHT_SHOULDER.value,
        PoseLandmark.LEFT_HIP.value,
        PoseLandmark.RIGHT_HIP.value,
        PoseLandmark.LEFT_ELBOW.value,
        PoseLandmark.RIGHT_ELBOW.value,
        PoseLandmark.LEFT_WRIST.value,
        PoseLandmark.RIGHT_WRIST.value,
    ]
    margin = 0.03
    return all(
        margin <= landmarks[index].x <= 1.0 - margin
        and margin <= landmarks[index].y <= 1.0 - margin
        for index in indexes
    )


def calibration_messages(landmarks, side: ArmSide) -> tuple[bool, list[str]]:
    messages: list[str] = []
    selected_arm_visibility = arm_visibility(landmarks, side)
    torso_score = torso_visibility(landmarks)

    if selected_arm_visibility < 0.65:
        messages.append("Improve tracked arm visibility")
    if torso_score < 0.65:
        messages.append("Show shoulders and hips")
    if not body_inside_frame(landmarks):
        messages.append("Move back or center body")
    if not messages:
        messages.append("Frame OK for capture")

    return len(messages) == 1 and messages[0] == "Frame OK for capture", messages


def choose_arm(landmarks, requested: str) -> ArmSide:
    if requested in {"left", "right"}:
        return requested

    left_visibility = arm_visibility(landmarks, "left")
    right_visibility = arm_visibility(landmarks, "right")
    return "left" if left_visibility >= right_visibility else "right"


def draw_arm(frame, shoulder: tuple[int, int], elbow: tuple[int, int], wrist: tuple[int, int]) -> None:
    cv2.line(frame, shoulder, elbow, (0, 180, 255), 4)
    cv2.line(frame, elbow, wrist, (0, 180, 255), 4)

    for point in (shoulder, elbow, wrist):
        cv2.circle(frame, point, 8, (20, 220, 120), -1)
        cv2.circle(frame, point, 11, (255, 255, 255), 2)


def draw_hud(frame, side: ArmSide, angle: float | None, tracker: CurlTracker, current_rom: float, is_logging: bool, coach_rep=None) -> None:
    cv2.rectangle(frame, (0, 0), (520, 190), (25, 25, 25), -1)
    cv2.putText(frame, f"ARM: {side.upper()}", (18, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2)
    cv2.putText(frame, f"REPS: {tracker.reps}", (18, 72), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (80, 220, 120), 2)
    angle_text = "--" if angle is None else f"{angle:.0f} deg"
    cv2.putText(frame, f"ELBOW: {angle_text}", (170, 72), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 180, 255), 2)
    cv2.putText(frame, f"ROM: {current_rom:.0f} deg", (18, 108), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
    quality = tracker.last_quality
    form_text = "FORM: --"
    form_color = (210, 210, 210)
    if quality:
        form_text = "FORM: GOOD" if quality.good_form else f"FORM: CHECK {','.join(quality.warnings).upper()}"
        form_color = (80, 220, 120) if quality.good_form else (0, 180, 255)
    cv2.putText(frame, form_text, (170, 108), cv2.FONT_HERSHEY_SIMPLEX, 0.62, form_color, 2)
    log_text = "LOG: ON" if is_logging else "LOG: OFF"
    log_color = (80, 220, 120) if is_logging else (150, 150, 150)
    cv2.putText(frame, log_text, (345, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.62, log_color, 2)
    if coach_rep:
        cv2.putText(frame, f"EFFORT: {coach_rep.effort_score:.0f}", (18, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 2)
        cv2.putText(frame, f"RISK: {coach_rep.failure_risk:.0f}%", (170, 140), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 2)
        cv2.putText(frame, f"COACH: {coach_rep.recommended_reps_remaining} reps left", (18, 170), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (80, 220, 120), 2)
    cv2.putText(frame, "Q quit | R reset", (345, 170), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (210, 210, 210), 1)


def draw_calibration(frame, is_ready: bool, messages: list[str]) -> None:
    height, width = frame.shape[:2]
    color = (80, 220, 120) if is_ready else (0, 180, 255)
    status = "CALIBRATION: READY" if is_ready else "CALIBRATION: ADJUST"

    cv2.rectangle(frame, (0, height - 140), (width, height), (25, 25, 25), -1)
    cv2.putText(frame, status, (18, height - 104), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
    cv2.putText(frame, "Use steady side or 45-degree view. Keep torso and working arm visible.", (18, height - 74), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (230, 230, 230), 1)

    for index, message in enumerate(messages[:2]):
        cv2.putText(frame, message, (18, height - 42 + index * 24), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (255, 255, 255), 1)


def ensure_pose_model(model_path: str) -> str:
    from pathlib import Path

    path = Path(model_path)
    if path.exists():
        return str(path)

    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading MediaPipe pose model to {path}...")
    urlretrieve(POSE_MODEL_URL, path)
    return str(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Webcam bicep curl counter using MediaPipe Pose.")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index.")
    parser.add_argument("--arm", choices=["auto", "left", "right"], default="auto", help="Arm to track.")
    parser.add_argument("--calibrate", action="store_true", help="Show framing guidance before collecting data.")
    parser.add_argument("--session", default="", help="Session id saved with each logged rep.")
    parser.add_argument("--label", default="unlabeled", help="Training label saved with each logged rep.")
    parser.add_argument("--no-log", action="store_true", help="Disable CSV logging.")
    parser.add_argument("--log-path", default="outputs/curl_reps.csv", help="CSV path for logged rep metrics.")
    parser.add_argument("--voice-coach", action="store_true", help="Speak live coach feedback after each counted rep.")
    parser.add_argument("--voice-rate", type=int, default=175, help="Text-to-speech words per minute.")
    parser.add_argument("--model-path", default="outputs/models/pose_landmarker_lite.task", help="Path to MediaPipe pose model.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    tracker = CurlTracker()
    selected_side: ArmSide = "right"
    current_rom = 0.0
    is_logging = not args.calibrate and not args.no_log
    session_id = args.session or datetime.now().strftime("session_%Y%m%d_%H%M%S")
    logger = RepLogger(session_id=session_id, label=args.label, path=Path(args.log_path)) if is_logging else None
    last_coach_rep = None
    profile_rows = load_rows(Path(args.log_path)) if Path(args.log_path).exists() else []
    live_coach = LiveCoach(build_user_profile(profile_rows))
    voice = VoiceCoach(enabled=args.voice_coach and not args.calibrate, rate=args.voice_rate)

    if logger:
        print(f"Logging reps to {logger.path} with session_id={session_id} label={args.label}")
    if args.voice_coach:
        voice.say("Coach de voz activado. Empezamos.")

    cap = cv2.VideoCapture(args.camera)
    if not cap.isOpened():
        print(f"Could not open webcam at index {args.camera}.")
        return 1

    model_path = ensure_pose_model(args.model_path)
    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    try:
        with PoseLandmarker.create_from_options(options) as landmarker:
            started_at = time.monotonic()
            while cap.isOpened():
                ok, frame = cap.read()
                if not ok:
                    print("Could not read frame from webcam.")
                    break

                frame = cv2.flip(frame, 1)
                height, width = frame.shape[:2]
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
                timestamp_ms = int((time.monotonic() - started_at) * 1000)
                result = landmarker.detect_for_video(mp_image, timestamp_ms)

                angle = None
                is_ready = False
                messages = ["No pose detected"]
                if result.pose_landmarks:
                    landmarks = result.pose_landmarks[0]
                    selected_side = choose_arm(landmarks, args.arm)
                    is_ready, messages = calibration_messages(landmarks, selected_side)
                    points = get_body_points(landmarks, selected_side, width, height)
                    shoulder = points["shoulder"]
                    elbow = points["elbow"]
                    wrist = points["wrist"]
                    angle = calculate_angle(shoulder, elbow, wrist)
                    torso_center = midpoint(points["left_hip"], points["right_hip"])
                    update = tracker.update(
                        CurlSample(
                            elbow_angle=angle,
                            shoulder=shoulder,
                            elbow=elbow,
                            wrist=wrist,
                            torso_center=torso_center,
                            timestamp_seconds=time.monotonic() - started_at,
                        )
                    )
                    current_rom = update.current_rom
                    coach_rep = None
                    if update.last_metrics:
                        coach_rep = live_coach.evaluate(update.last_metrics)
                        last_coach_rep = coach_rep
                        if update.last_metrics.counted_rep:
                            voice.say(coach_message(coach_rep))
                    if logger and update.last_metrics:
                        logger.log(update.last_metrics, selected_side, coach_rep=coach_rep)
                    draw_arm(frame, shoulder, elbow, wrist)
                    cv2.putText(frame, f"{angle:.0f}", elbow, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

                draw_hud(frame, selected_side, angle, tracker, current_rom, is_logging, coach_rep=last_coach_rep)
                if args.calibrate:
                    draw_calibration(frame, is_ready, messages)
                cv2.imshow("Curl Vision Foundry - Webcam Curl Counter", frame)

                key = cv2.waitKey(10) & 0xFF
                if key == ord("q"):
                    break
                if key == ord("r"):
                    tracker.reset()
                    current_rom = 0.0
                    last_coach_rep = None
    finally:
        voice.close()

    cap.release()
    cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
