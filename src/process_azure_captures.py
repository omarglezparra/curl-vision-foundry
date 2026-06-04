from __future__ import annotations

import argparse
import csv
import json
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
from azure.core.exceptions import ResourceExistsError
from azure.storage.blob import BlobServiceClient, ContentSettings
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

from curl_rules import CurlSample, CurlTracker, midpoint
from webcam_curl_counter import calculate_angle, choose_arm, ensure_pose_model, get_body_points


CAPTURE_FIELDS = [
    "processed_at_utc",
    "capture_id",
    "session_id",
    "label",
    "camera_angle",
    "drill_id",
    "drill_title",
    "video_blob",
    "metadata_blob",
    "frames_total",
    "frames_processed",
    "frames_with_pose",
    "pose_detection_rate",
    "selected_arm",
    "attempts",
    "counted_reps",
    "good_reps",
    "form_warnings",
    "avg_range_of_motion",
    "avg_rep_speed",
    "avg_shoulder_shift_ratio",
    "avg_torso_shift_ratio",
    "avg_wrist_path_std_ratio",
]

REP_FIELDS = [
    "processed_at_utc",
    "capture_id",
    "session_id",
    "label",
    "camera_angle",
    "drill_id",
    "drill_title",
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
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process iPhone Azure Blob curl captures into a dataset.")
    parser.add_argument("--resource-group", default="rg-curl-vision-trainer")
    parser.add_argument("--account-name", default="curlvision449605")
    parser.add_argument("--captures-container", default="captures")
    parser.add_argument("--processed-container", default="processed")
    parser.add_argument("--output-dir", default="outputs/cloud_dataset")
    parser.add_argument("--model-path", default="outputs/models/pose_landmarker_lite.task")
    parser.add_argument("--arm", choices=["auto", "left", "right"], default="auto")
    parser.add_argument("--frame-stride", type=int, default=2, help="Process every Nth frame for speed.")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of captures processed.")
    parser.add_argument("--no-upload-results", action="store_true")
    return parser.parse_args()


def az_storage_key(resource_group: str, account_name: str) -> str:
    az_executable = shutil.which("az") or shutil.which("az.cmd")
    if not az_executable:
        raise RuntimeError("Azure CLI was not found on PATH. Run az login, then retry.")

    result = subprocess.run(
        [
            az_executable,
            "storage",
            "account",
            "keys",
            "list",
            "--resource-group",
            resource_group,
            "--account-name",
            account_name,
            "--query",
            "[0].value",
            "--output",
            "tsv",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def connection_string(account_name: str, account_key: str) -> str:
    return (
        "DefaultEndpointsProtocol=https;"
        f"AccountName={account_name};"
        f"AccountKey={account_key};"
        "EndpointSuffix=core.windows.net"
    )


def list_capture_prefixes(service: BlobServiceClient, container_name: str) -> list[dict[str, str]]:
    container = service.get_container_client(container_name)
    metadata_blobs = [blob.name for blob in container.list_blobs() if blob.name.endswith("/metadata.json")]
    captures: list[dict[str, str]] = []
    for metadata_blob in sorted(metadata_blobs):
        prefix = metadata_blob[: -len("/metadata.json")]
        video_blob = f"{prefix}/video.webm"
        captures.append({"prefix": prefix, "metadata_blob": metadata_blob, "video_blob": video_blob})
    return captures


def download_text(service: BlobServiceClient, container_name: str, blob_name: str) -> str:
    blob = service.get_blob_client(container_name, blob_name)
    return blob.download_blob().readall().decode("utf-8-sig")


def download_blob_to_path(service: BlobServiceClient, container_name: str, blob_name: str, path: Path) -> None:
    blob = service.get_blob_client(container_name, blob_name)
    with path.open("wb") as file:
        blob.download_blob().readinto(file)


def safe_float(value: float) -> float:
    return round(float(value), 4)


def avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def rep_row(processed_at: str, metadata: dict[str, Any], arm: str, metrics) -> dict[str, Any]:
    return {
        "processed_at_utc": processed_at,
        "capture_id": metadata.get("capture_id", ""),
        "session_id": metadata.get("session_id", ""),
        "label": metadata.get("label", ""),
        "camera_angle": metadata.get("camera_angle", ""),
        "drill_id": metadata.get("drill_id", ""),
        "drill_title": metadata.get("drill_title", ""),
        "arm": arm,
        "attempt_number": metrics.attempt_number,
        "rep_number": metrics.rep_number,
        "counted_rep": metrics.counted_rep,
        "min_elbow_angle": safe_float(metrics.min_elbow_angle),
        "max_elbow_angle": safe_float(metrics.max_elbow_angle),
        "range_of_motion": safe_float(metrics.range_of_motion),
        "duration_seconds": safe_float(metrics.duration_seconds),
        "rep_speed_degrees_per_second": safe_float(metrics.rep_speed_degrees_per_second),
        "shoulder_shift_ratio": safe_float(metrics.shoulder_shift_ratio),
        "torso_shift_ratio": safe_float(metrics.torso_shift_ratio),
        "wrist_path_std_ratio": safe_float(metrics.wrist_path_std_ratio),
        "good_form": metrics.quality.good_form,
        "warnings": "|".join(metrics.quality.warnings),
    }


def process_video(video_path: Path, metadata: dict[str, Any], landmarker: PoseLandmarker, arm: str, frame_stride: int) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tracker = CurlTracker()
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    processed_at = datetime.now(timezone.utc).isoformat()
    frames_total = 0
    frames_processed = 0
    frames_with_pose = 0
    selected_arm = "unknown"
    rows: list[dict[str, Any]] = []

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            frames_total += 1
            if frames_total % max(frame_stride, 1) != 0:
                continue

            frames_processed += 1
            height, width = frame.shape[:2]
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
            timestamp_ms = int(frames_total * 1000 / fps)
            result = landmarker.detect_for_video(mp_image, timestamp_ms)

            if not result.pose_landmarks:
                continue

            frames_with_pose += 1
            landmarks = result.pose_landmarks[0]
            selected_arm = choose_arm(landmarks, arm)
            points = get_body_points(landmarks, selected_arm, width, height)
            shoulder = points["shoulder"]
            elbow = points["elbow"]
            wrist = points["wrist"]
            torso_center = midpoint(points["left_hip"], points["right_hip"])
            angle = calculate_angle(shoulder, elbow, wrist)
            update = tracker.update(
                CurlSample(
                    elbow_angle=angle,
                    shoulder=shoulder,
                    elbow=elbow,
                    wrist=wrist,
                    torso_center=torso_center,
                    timestamp_seconds=timestamp_ms / 1000.0,
                )
            )
            if update.last_metrics:
                rows.append(rep_row(processed_at, metadata, selected_arm, update.last_metrics))
    finally:
        cap.release()

    warning_set = sorted({warning for row in rows for warning in str(row["warnings"]).split("|") if warning})
    counted_rows = [row for row in rows if row["counted_rep"]]
    summary = {
        "processed_at_utc": processed_at,
        "capture_id": metadata.get("capture_id", ""),
        "session_id": metadata.get("session_id", ""),
        "label": metadata.get("label", ""),
        "camera_angle": metadata.get("camera_angle", ""),
        "drill_id": metadata.get("drill_id", ""),
        "drill_title": metadata.get("drill_title", ""),
        "video_blob": "",
        "metadata_blob": "",
        "frames_total": frames_total,
        "frames_processed": frames_processed,
        "frames_with_pose": frames_with_pose,
        "pose_detection_rate": safe_float(frames_with_pose / frames_processed) if frames_processed else 0.0,
        "selected_arm": selected_arm,
        "attempts": len(rows),
        "counted_reps": len(counted_rows),
        "good_reps": sum(1 for row in rows if row["good_form"]),
        "form_warnings": "|".join(warning_set),
        "avg_range_of_motion": safe_float(avg([row["range_of_motion"] for row in rows])),
        "avg_rep_speed": safe_float(avg([row["rep_speed_degrees_per_second"] for row in rows])),
        "avg_shoulder_shift_ratio": safe_float(avg([row["shoulder_shift_ratio"] for row in rows])),
        "avg_torso_shift_ratio": safe_float(avg([row["torso_shift_ratio"] for row in rows])),
        "avg_wrist_path_std_ratio": safe_float(avg([row["wrist_path_std_ratio"] for row in rows])),
    }
    return summary, rows


def write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fieldnames})


def upload_result(service: BlobServiceClient, container_name: str, local_path: Path, blob_name: str) -> None:
    try:
        service.create_container(container_name)
    except ResourceExistsError:
        pass
    blob = service.get_blob_client(container_name, blob_name)
    blob.upload_blob(
        local_path.read_bytes(),
        overwrite=True,
        content_settings=ContentSettings(content_type="text/csv"),
    )


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    model_path = ensure_pose_model(args.model_path)
    account_key = az_storage_key(args.resource_group, args.account_name)
    service = BlobServiceClient.from_connection_string(connection_string(args.account_name, account_key))
    captures = list_capture_prefixes(service, args.captures_container)
    if args.limit:
        captures = captures[: args.limit]

    options = PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model_path),
        running_mode=RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    summaries: list[dict[str, Any]] = []
    rep_rows: list[dict[str, Any]] = []

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        for index, capture in enumerate(captures, start=1):
            metadata = json.loads(download_text(service, args.captures_container, capture["metadata_blob"]))
            video_path = temp_path / f"{metadata.get('capture_id', index)}.webm"
            print(f"[{index}/{len(captures)}] Downloading {capture['video_blob']}")
            download_blob_to_path(service, args.captures_container, capture["video_blob"], video_path)
            print(f"[{index}/{len(captures)}] Processing {metadata.get('drill_title', capture['prefix'])}")
            with PoseLandmarker.create_from_options(options) as landmarker:
                summary, rows = process_video(video_path, metadata, landmarker, args.arm, args.frame_stride)
            summary["video_blob"] = capture["video_blob"]
            summary["metadata_blob"] = capture["metadata_blob"]
            summaries.append(summary)
            rep_rows.extend(rows)

    summary_path = output_dir / "cloud_capture_summary.csv"
    dataset_path = output_dir / "cloud_curl_dataset.csv"
    write_csv(summary_path, CAPTURE_FIELDS, summaries)
    write_csv(dataset_path, REP_FIELDS, rep_rows)
    print(f"Wrote {summary_path}")
    print(f"Wrote {dataset_path}")
    print(f"Captures processed: {len(summaries)}")
    print(f"Rep attempts detected: {len(rep_rows)}")

    if not args.no_upload_results:
        upload_result(service, args.processed_container, summary_path, "datasets/cloud_capture_summary.csv")
        upload_result(service, args.processed_container, dataset_path, "datasets/cloud_curl_dataset.csv")
        print(f"Uploaded CSV outputs to Azure container: {args.processed_container}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
