from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import platform
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse
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
SourceKind = Literal["camera", "video_file", "stream"]
POSE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
)
VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"}


@dataclass(frozen=True)
class CaptureSource:
    raw: str
    open_value: int | str
    kind: SourceKind
    label: str


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


def draw_hud(
    frame,
    side: ArmSide,
    angle: float | None,
    tracker: CurlTracker,
    current_rom: float,
    is_logging: bool,
    is_video_recording: bool = False,
    coach_rep=None,
) -> None:
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
    video_text = "VIDEO: REC" if is_video_recording else "VIDEO: OFF"
    video_color = (0, 80, 255) if is_video_recording else (150, 150, 150)
    cv2.putText(frame, video_text, (345, 58), cv2.FONT_HERSHEY_SIMPLEX, 0.58, video_color, 2)
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


def safe_slug(value: str, fallback: str = "capture") -> str:
    slug = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in value.strip())
    slug = "_".join(part for part in slug.split("_") if part)
    return slug or fallback


def safe_source_label(raw: str) -> str:
    if "://" not in raw:
        return raw

    parsed = urlparse(raw)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


def is_camera_index(value: str) -> bool:
    try:
        return int(value) >= 0
    except ValueError:
        return False


def resolve_capture_source(source: str, camera: int) -> CaptureSource:
    raw = (source or str(camera)).strip()
    if is_camera_index(raw):
        index = int(raw)
        return CaptureSource(raw=raw, open_value=index, kind="camera", label=f"camera {index}")

    lowered = raw.lower()
    if lowered.startswith(("http://", "https://", "rtsp://", "rtmp://", "udp://", "tcp://")):
        return CaptureSource(raw=raw, open_value=raw, kind="stream", label=safe_source_label(raw))

    path = Path(raw).expanduser()
    kind: SourceKind = "video_file" if path.suffix.lower() in VIDEO_EXTENSIONS or path.exists() else "stream"
    return CaptureSource(raw=raw, open_value=str(path), kind=kind, label=str(path))


def camera_backend() -> int:
    return cv2.CAP_DSHOW if platform.system() == "Windows" and hasattr(cv2, "CAP_DSHOW") else cv2.CAP_ANY


def open_capture(source: CaptureSource) -> cv2.VideoCapture:
    if source.kind != "camera":
        return cv2.VideoCapture(str(source.open_value))

    cap = cv2.VideoCapture(int(source.open_value), camera_backend())
    if cap.isOpened():
        return cap

    cap.release()
    return cv2.VideoCapture(int(source.open_value))


def list_cameras(max_camera_index: int) -> None:
    print("OpenCV camera probe:")
    found = False
    for index in range(max_camera_index + 1):
        cap = cv2.VideoCapture(index, camera_backend())
        if not cap.isOpened():
            cap.release()
            continue

        ok, _ = cap.read()
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        print(f"  --source {index}: {width}x{height} at {fps:.1f} fps, frame={'ok' if ok else 'not ready'}")
        found = True
        cap.release()

    if not found:
        print("  No cameras opened. If the glasses use a phone app only, export a clip and use --source path\\to\\video.mp4.")


def source_timestamp_seconds(source: CaptureSource, started_at: float, frame_index: int, fps: float) -> float:
    if source.kind == "video_file":
        return frame_index / max(fps, 1.0)
    return time.monotonic() - started_at


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Webcam bicep curl counter using MediaPipe Pose.")
    parser.add_argument("--camera", type=int, default=0, help="Fallback OpenCV camera index when --source is not set.")
    parser.add_argument("--source", default="", help="OpenCV source: camera index, local video file, or stream URL.")
    parser.add_argument("--list-cameras", action="store_true", help="Probe OpenCV camera indexes, then exit.")
    parser.add_argument("--max-camera-index", type=int, default=8, help="Highest camera index to probe with --list-cameras.")
    parser.add_argument("--headless", action="store_true", help="Process without opening a preview window.")
    parser.add_argument("--no-flip", action="store_true", help="Keep the raw image orientation instead of mirroring it.")
    parser.add_argument("--arm", choices=["auto", "left", "right"], default="auto", help="Arm to track.")
    parser.add_argument("--calibrate", action="store_true", help="Show framing guidance before collecting data.")
    parser.add_argument("--session", default="", help="Session id saved with each logged rep.")
    parser.add_argument("--label", default="unlabeled", help="Training label saved with each logged rep.")
    parser.add_argument("--no-log", action="store_true", help="Disable CSV logging.")
    parser.add_argument("--log-good-only", action="store_true", help="Only write reps scored as good form to the CSV.")
    parser.add_argument("--log-path", default="outputs/curl_reps.csv", help="CSV path for logged rep metrics.")
    parser.add_argument("--record-session", action="store_true", help="Save the full webcam session video plus metadata.")
    parser.add_argument("--video-output-dir", default="outputs/session_videos", help="Directory for recorded session videos.")
    parser.add_argument("--camera-angle", default="webcam", help="Camera angle saved in recording metadata.")
    parser.add_argument("--exercise", default="biceps_curl", help="Exercise name saved in recording metadata.")
    parser.add_argument("--voice-coach", action="store_true", help="Speak live coach feedback after each counted rep.")
    parser.add_argument("--voice-rate", type=int, default=175, help="Text-to-speech words per minute.")
    parser.add_argument("--model-path", default="outputs/models/pose_landmarker_lite.task", help="Path to MediaPipe pose model.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.list_cameras:
        list_cameras(args.max_camera_index)
        return 0

    source = resolve_capture_source(args.source, args.camera)
    tracker = CurlTracker()
    selected_side: ArmSide = "right"
    current_rom = 0.0
    is_logging = not args.calibrate and not args.no_log
    session_id = args.session or datetime.now().strftime("session_%Y%m%d_%H%M%S")
    logger = RepLogger(session_id=session_id, label=args.label, path=Path(args.log_path)) if is_logging else None
    capture_id = f"{session_id}_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}_{uuid.uuid4().hex[:8]}"
    recording_dir = (
        Path(args.video_output_dir)
        / safe_slug(args.label, "unlabeled")
        / safe_slug(args.camera_angle, "webcam")
        / safe_slug(session_id, "session")
        / safe_slug(capture_id, "capture")
    )
    video_path = recording_dir / "video.mp4"
    metadata_path = recording_dir / "metadata.json"
    recording_started_at = datetime.now(timezone.utc)
    video_writer = None
    recording_fps = 0.0
    frames_recorded = 0
    last_coach_rep = None
    profile_rows = load_rows(Path(args.log_path)) if Path(args.log_path).exists() else []
    live_coach = LiveCoach(build_user_profile(profile_rows))
    voice = VoiceCoach(enabled=args.voice_coach and not args.calibrate, rate=args.voice_rate)

    if logger:
        print(f"Logging reps to {logger.path} with session_id={session_id} label={args.label}")
        if args.log_good_only:
            print("CSV logging is restricted to reps scored as good_form=True.")
    if args.record_session:
        print(f"Recording session video to {video_path}")
    if args.voice_coach:
        voice.say("Coach de voz activado. Empezamos.")

    print(f"Opening {source.kind}: {source.label}")
    cap = open_capture(source)
    if not cap.isOpened():
        print(f"Could not open {source.kind} source: {source.label}")
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
            source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            frame_index = 0
            while cap.isOpened():
                ok, frame = cap.read()
                if not ok:
                    print("Could not read frame from source.")
                    break

                timestamp_seconds = source_timestamp_seconds(source, started_at, frame_index, source_fps)
                frame_index += 1
                if not args.no_flip:
                    frame = cv2.flip(frame, 1)
                height, width = frame.shape[:2]
                recording_frame = frame.copy()
                if args.record_session:
                    if video_writer is None:
                        recording_dir.mkdir(parents=True, exist_ok=True)
                        recording_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
                        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                        video_writer = cv2.VideoWriter(str(video_path), fourcc, recording_fps, (width, height))
                        if not video_writer.isOpened():
                            print(f"Could not start video writer at {video_path}.")
                            video_writer = None
                            args.record_session = False
                    if video_writer:
                        video_writer.write(recording_frame)
                        frames_recorded += 1

                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
                timestamp_ms = int(timestamp_seconds * 1000)
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
                            timestamp_seconds=timestamp_seconds,
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
                        if not args.log_good_only or update.last_metrics.quality.good_form:
                            logger.log(update.last_metrics, selected_side, coach_rep=coach_rep)
                    draw_arm(frame, shoulder, elbow, wrist)
                    cv2.putText(frame, f"{angle:.0f}", elbow, cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

                draw_hud(
                    frame,
                    selected_side,
                    angle,
                    tracker,
                    current_rom,
                    is_logging,
                    is_video_recording=video_writer is not None,
                    coach_rep=last_coach_rep,
                )
                if args.calibrate:
                    draw_calibration(frame, is_ready, messages)
                if args.headless:
                    continue

                cv2.imshow("Curl Vision Foundry - Webcam Curl Counter", frame)
                key = cv2.waitKey(10) & 0xFF
                if key == ord("q"):
                    break
                if key == ord("r"):
                    tracker.reset()
                    current_rom = 0.0
                    last_coach_rep = None
    finally:
        if video_writer:
            video_writer.release()
            recording_ended_at = datetime.now(timezone.utc)
            duration_seconds = (
                frames_recorded / recording_fps
                if source.kind == "video_file" and recording_fps
                else (recording_ended_at - recording_started_at).total_seconds()
            )
            metadata = {
                "capture_id": capture_id,
                "session_id": session_id,
                "workout_id": session_id,
                "label": args.label,
                "exercise": args.exercise,
                "camera_angle": args.camera_angle,
                "capture_type": "full_session",
                "created_at": recording_ended_at.isoformat(),
                "recording_started_at": recording_started_at.isoformat(),
                "duration_seconds": round(duration_seconds, 2),
                "frames_recorded": frames_recorded,
                "fps": recording_fps,
                "selected_arm": selected_side,
                "source": "webcam_curl_counter",
                "source_type": source.kind,
                "input_source": source.label,
                "mirrored_input": not args.no_flip,
                "training_intent": "good_form_only" if args.log_good_only or args.label == "good_form" else "mixed",
                "use_for_training": args.exercise == "biceps_curl" and args.label == "good_form",
                "video_file": video_path.name,
                "log_path": str(args.log_path) if logger else "",
            }
            metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
            print(f"Recorded {frames_recorded} frames to {video_path}")
            print(f"Wrote recording metadata to {metadata_path}")
        voice.close()

    cap.release()
    if not args.headless:
        cv2.destroyAllWindows()
    print(f"Session complete: source={source.label} attempts={tracker.attempts} reps={tracker.reps}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
