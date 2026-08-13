from __future__ import annotations

import argparse
import csv
from contextlib import contextmanager
import io
import json
import os
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient, ContentSettings
from dotenv import load_dotenv
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import PoseLandmarker, PoseLandmarkerOptions, RunningMode

from azure_capture_uploader import AzureCaptureConfig, create_blob_service, is_configured_value
from curl_rules import CurlSample, CurlTracker, midpoint
from pose_processing import calculate_angle, choose_arm, ensure_pose_model, get_body_points
from video_geometry import GEOMETRY_METADATA_FIELDS, VideoGeometry, apply_analysis_transform


CAPTURE_FIELDS = [
    "processed_at_utc",
    "capture_id",
    "session_id",
    "profile_id",
    "capture_created_at_utc",
    "workout_id",
    "label",
    "exercise",
    "camera_angle",
    "capture_type",
    "training_intent",
    "use_for_training",
    "analysis_type",
    "drill_id",
    "drill_title",
    *GEOMETRY_METADATA_FIELDS,
    "video_blob",
    "metadata_blob",
    "duration_seconds",
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
    "profile_id",
    "capture_created_at_utc",
    "workout_id",
    "label",
    "exercise",
    "camera_angle",
    "capture_type",
    "training_intent",
    "use_for_training",
    "drill_id",
    "drill_title",
    *GEOMETRY_METADATA_FIELDS,
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

PROFILE_TOMBSTONE_PREFIX = "privacy/deleted-profiles"
DATASET_WRITE_LOCK_BLOB = "privacy/dataset-write.lock"
DATASET_LOCK_SECONDS = 60
DATASET_LOCK_WAIT_SECONDS = 30


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Process iPhone Azure Blob curl captures into a dataset.")
    parser.add_argument("--resource-group", default=os.getenv("AZURE_RESOURCE_GROUP", "rg-curl-vision-trainer"))
    parser.add_argument("--account-name", default=os.getenv("AZURE_STORAGE_ACCOUNT_NAME", ""))
    parser.add_argument("--captures-container", default=os.getenv("AZURE_CAPTURE_CONTAINER", "captures"))
    parser.add_argument("--processed-container", default=os.getenv("AZURE_PROCESSED_CONTAINER", "processed"))
    parser.add_argument("--output-dir", default="outputs/cloud_dataset")
    parser.add_argument("--model-path", default="outputs/models/pose_landmarker_lite.task")
    parser.add_argument("--arm", choices=["auto", "left", "right"], default="auto")
    parser.add_argument("--frame-stride", type=int, default=2, help="Process every Nth frame for speed.")
    parser.add_argument("--exercise-filter", default="biceps_curl", help="Only process this exercise; use 'all' to process every capture.")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of captures processed.")
    parser.add_argument("--no-upload-results", action="store_true")
    parser.add_argument(
        "--incremental",
        action="store_true",
        help="Merge only captures not already present in the uploaded summary dataset.",
    )
    parser.add_argument(
        "--derived-retention-days",
        type=int,
        default=int(os.getenv("AZURE_DERIVED_DATA_RETENTION_DAYS", "365")),
        help="Remove derived rows older than this many days (default: 365).",
    )
    return parser.parse_args()


def list_capture_prefixes(service: BlobServiceClient, container_name: str) -> list[dict[str, str]]:
    container = service.get_container_client(container_name)
    metadata_blobs = [blob.name for blob in container.list_blobs() if blob.name.endswith("/metadata.json")]
    captures: list[dict[str, str]] = []
    for metadata_blob in sorted(metadata_blobs):
        prefix = metadata_blob[: -len("/metadata.json")]
        captures.append({"prefix": prefix, "metadata_blob": metadata_blob})
    return captures


def download_text(service: BlobServiceClient, container_name: str, blob_name: str) -> str:
    blob = service.get_blob_client(container_name, blob_name)
    return blob.download_blob().readall().decode("utf-8-sig")


def download_csv_rows_if_exists(
    service: BlobServiceClient,
    container_name: str,
    blob_name: str,
) -> list[dict[str, str]]:
    try:
        raw = download_text(service, container_name, blob_name)
    except ResourceNotFoundError:
        return []
    reader = csv.DictReader(io.StringIO(raw.lstrip("\ufeff")))
    if not reader.fieldnames:
        return []
    return [dict(row) for row in reader]


def download_blob_to_path(service: BlobServiceClient, container_name: str, blob_name: str, path: Path) -> None:
    blob = service.get_blob_client(container_name, blob_name)
    with path.open("wb") as file:
        blob.download_blob().readinto(file)


def safe_float(value: float) -> float:
    return round(float(value), 4)


def avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def rep_row(
    processed_at: str,
    metadata: dict[str, Any],
    geometry: VideoGeometry,
    arm: str,
    metrics,
) -> dict[str, Any]:
    row = {
        "processed_at_utc": processed_at,
        "capture_id": metadata.get("capture_id", ""),
        "session_id": metadata.get("session_id", ""),
        "profile_id": metadata.get("profile_id", "owner"),
        "capture_created_at_utc": metadata.get("created_at", ""),
        "workout_id": metadata.get("workout_id", metadata.get("session_id", "")),
        "label": metadata.get("label", ""),
        "exercise": metadata.get("exercise", "biceps_curl"),
        "camera_angle": metadata.get("camera_angle", ""),
        "capture_type": metadata.get("capture_type", "set"),
        "training_intent": metadata.get("training_intent", ""),
        "use_for_training": metadata.get("use_for_training", ""),
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
    row.update(geometry.to_metadata())
    return row


def process_video(
    video_path: Path,
    metadata: dict[str, Any],
    landmarker: PoseLandmarker,
    arm: str,
    frame_stride: int,
    *,
    analyze_curls: bool = True,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tracker = CurlTracker()
    geometry = VideoGeometry.from_metadata(metadata)
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
            frame = apply_analysis_transform(frame, geometry)
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
            if not analyze_curls:
                continue
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
                rows.append(rep_row(processed_at, metadata, geometry, selected_arm, update.last_metrics))
    finally:
        cap.release()

    warning_set = sorted({warning for row in rows for warning in str(row["warnings"]).split("|") if warning})
    counted_rows = [row for row in rows if row["counted_rep"]]
    summary = {
        "processed_at_utc": processed_at,
        "capture_id": metadata.get("capture_id", ""),
        "session_id": metadata.get("session_id", ""),
        "profile_id": metadata.get("profile_id", "owner"),
        "capture_created_at_utc": metadata.get("created_at", ""),
        "workout_id": metadata.get("workout_id", metadata.get("session_id", "")),
        "label": metadata.get("label", ""),
        "exercise": metadata.get("exercise", "biceps_curl"),
        "camera_angle": metadata.get("camera_angle", ""),
        "capture_type": metadata.get("capture_type", "set"),
        "training_intent": metadata.get("training_intent", ""),
        "use_for_training": metadata.get("use_for_training", ""),
        "analysis_type": "biceps_curl" if analyze_curls else "pose_archive_only",
        "drill_id": metadata.get("drill_id", ""),
        "drill_title": metadata.get("drill_title", ""),
        **geometry.to_metadata(),
        "video_blob": "",
        "metadata_blob": "",
        "duration_seconds": metadata.get("duration_seconds", ""),
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


def parse_utc_timestamp(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def load_profile_tombstones(
    service: BlobServiceClient,
    processed_container: str,
) -> dict[str, datetime]:
    tombstones: dict[str, datetime] = {}
    try:
        blobs = service.get_container_client(processed_container).list_blobs(
            name_starts_with=f"{PROFILE_TOMBSTONE_PREFIX}/"
        )
        for blob in blobs:
            try:
                raw = service.get_blob_client(processed_container, blob.name).download_blob().readall()
                document = json.loads(raw.decode("utf-8-sig") if isinstance(raw, bytes) else str(raw))
                if not isinstance(document, dict):
                    continue
                profile_id = str(document.get("profile_id") or "").strip()
                deleted_at = parse_utc_timestamp(document.get("deleted_at"))
                if profile_id and deleted_at:
                    tombstones[profile_id] = max(tombstones.get(profile_id, deleted_at), deleted_at)
            except (ResourceNotFoundError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
                continue
    except ResourceNotFoundError:
        pass
    return tombstones


def filter_tombstoned_rows(
    rows: list[dict[str, Any]],
    tombstones: dict[str, datetime],
) -> list[dict[str, Any]]:
    """Exclude captures made at or before a profile's latest deletion request."""
    filtered: list[dict[str, Any]] = []
    for row in rows:
        deleted_at = tombstones.get(str(row.get("profile_id") or "owner").strip())
        if deleted_at is None:
            filtered.append(row)
            continue
        captured_at = parse_utc_timestamp(row.get("capture_created_at_utc"))
        if captured_at is not None and captured_at > deleted_at:
            filtered.append(row)
    return filtered


def capture_row_identity(row: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(row.get("profile_id") or "owner").strip(),
        str(row.get("session_id") or row.get("workout_id") or "").strip(),
        str(row.get("capture_id") or "").strip(),
    )


def merge_incremental_rows(
    existing_summaries: list[dict[str, Any]],
    existing_rep_rows: list[dict[str, Any]],
    new_summaries: list[dict[str, Any]],
    new_rep_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Replace newly processed captures while retaining prior derived rows."""
    summary_by_capture = {
        capture_row_identity(row): row
        for row in existing_summaries
        if all(capture_row_identity(row)[1:])
    }
    new_capture_keys = {capture_row_identity(row) for row in new_summaries}
    for row in new_summaries:
        summary_by_capture[capture_row_identity(row)] = row

    retained_rep_rows = [
        row for row in existing_rep_rows if capture_row_identity(row) not in new_capture_keys
    ]
    rep_by_attempt: dict[tuple[str, ...], dict[str, Any]] = {}
    for row in [*retained_rep_rows, *new_rep_rows]:
        key = (
            *capture_row_identity(row),
            str(row.get("arm") or "").strip(),
            str(row.get("attempt_number") or "").strip(),
            str(row.get("rep_number") or "").strip(),
        )
        rep_by_attempt[key] = row
    return list(summary_by_capture.values()), list(rep_by_attempt.values())


def filter_retained_rows(
    rows: list[dict[str, Any]],
    retention_days: int,
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Enforce row-level expiry because shared CSV blob age cannot expire old rows."""
    if retention_days < 1:
        raise ValueError("Derived-data retention must be at least one day.")
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    cutoff = reference.astimezone(timezone.utc) - timedelta(days=retention_days)
    retained: list[dict[str, Any]] = []
    for row in rows:
        row_time = parse_utc_timestamp(row.get("capture_created_at_utc"))
        if row_time is None:
            row_time = parse_utc_timestamp(row.get("processed_at_utc"))
        if row_time is not None and row_time >= cutoff:
            retained.append(row)
    return retained


@contextmanager
def dataset_write_lock(service: BlobServiceClient, processed_container: str):
    """Coordinate complete dataset replacement with the Function deletion path."""
    try:
        service.create_container(processed_container)
    except ResourceExistsError:
        pass
    lock_blob = service.get_blob_client(processed_container, DATASET_WRITE_LOCK_BLOB)
    try:
        lock_blob.upload_blob(
            b"",
            overwrite=False,
            content_settings=ContentSettings(content_type="application/octet-stream"),
        )
    except ResourceExistsError:
        pass

    deadline = time.monotonic() + DATASET_LOCK_WAIT_SECONDS
    while True:
        try:
            lease = lock_blob.acquire_lease(lease_duration=DATASET_LOCK_SECONDS)
            break
        except HttpResponseError as exc:
            if exc.status_code != 409 or time.monotonic() >= deadline:
                raise
            time.sleep(0.5)
    try:
        yield lease
    finally:
        lease.release()


def main() -> int:
    load_dotenv()
    args = parse_args()
    if args.derived_retention_days < 1 or args.derived_retention_days > 3650:
        raise ValueError("--derived-retention-days must be from 1 to 3650.")
    output_dir = Path(args.output_dir)
    model_path = ensure_pose_model(args.model_path)
    config = AzureCaptureConfig(
        storage_account_name=args.account_name,
        capture_container=args.captures_container,
        processed_container=args.processed_container,
        connection_string=os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip(),
    )
    if not config.configured or (
        not is_configured_value(config.storage_account_name)
        and not is_configured_value(config.connection_string)
    ):
        raise RuntimeError("Set AZURE_STORAGE_ACCOUNT_NAME in .env and run az login first.")
    service = create_blob_service(config)
    captures = list_capture_prefixes(service, args.captures_container)
    existing_summaries: list[dict[str, Any]] = []
    existing_rep_rows: list[dict[str, Any]] = []
    if args.incremental:
        existing_summaries = download_csv_rows_if_exists(
            service,
            args.processed_container,
            "datasets/cloud_capture_summary.csv",
        )
        existing_rep_rows = download_csv_rows_if_exists(
            service,
            args.processed_container,
            "datasets/cloud_curl_dataset.csv",
        )
        processed_metadata_blobs = {
            str(row.get("metadata_blob") or "").strip()
            for row in existing_summaries
            if str(row.get("metadata_blob") or "").strip()
        }
        captures = [
            capture
            for capture in captures
            if capture["metadata_blob"] not in processed_metadata_blobs
        ]
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
    failures = 0

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        for index, capture in enumerate(captures, start=1):
            try:
                metadata = json.loads(download_text(service, args.captures_container, capture["metadata_blob"]))
                exercise = metadata.get("exercise", "biceps_curl")
                if args.exercise_filter != "all" and exercise != args.exercise_filter:
                    print(f"[{index}/{len(captures)}] Skipping {capture['prefix']} exercise={exercise}")
                    continue
                video_file = metadata.get("video_file", "video.webm")
                video_blob = metadata.get("video_blob") or f"{capture['prefix']}/{video_file}"
                video_path = temp_path / f"{metadata.get('capture_id', index)}_{video_file}"
                print(f"[{index}/{len(captures)}] Downloading {video_blob}")
                download_blob_to_path(service, args.captures_container, video_blob, video_path)
                analysis = "curl metrics" if exercise == "biceps_curl" else "pose archive"
                print(f"[{index}/{len(captures)}] Processing {capture['prefix']} ({analysis})")
                with PoseLandmarker.create_from_options(options) as landmarker:
                    summary, rows = process_video(
                        video_path,
                        metadata,
                        landmarker,
                        args.arm,
                        args.frame_stride,
                        analyze_curls=exercise == "biceps_curl",
                    )
                summary["video_blob"] = video_blob
                summary["metadata_blob"] = capture["metadata_blob"]
                summaries.append(summary)
                rep_rows.extend(rows)
            except Exception as exc:
                failures += 1
                print(f"[{index}/{len(captures)}] Failed {capture['prefix']}: {type(exc).__name__}: {exc}")

    summary_path = output_dir / "cloud_capture_summary.csv"
    dataset_path = output_dir / "cloud_curl_dataset.csv"
    candidate_summaries, candidate_rep_rows = merge_incremental_rows(
        existing_summaries,
        existing_rep_rows,
        summaries,
        rep_rows,
    )
    filtered_summaries = candidate_summaries
    filtered_rep_rows = candidate_rep_rows

    if not args.no_upload_results and failures == 0:
        with dataset_write_lock(service, args.processed_container) as lease:
            tombstones = load_profile_tombstones(service, args.processed_container)
            filtered_summaries = filter_retained_rows(
                filter_tombstoned_rows(candidate_summaries, tombstones),
                args.derived_retention_days,
            )
            filtered_rep_rows = filter_retained_rows(
                filter_tombstoned_rows(candidate_rep_rows, tombstones),
                args.derived_retention_days,
            )
            write_csv(summary_path, CAPTURE_FIELDS, filtered_summaries)
            write_csv(dataset_path, REP_FIELDS, filtered_rep_rows)
            lease.renew()
            upload_result(
                service,
                args.processed_container,
                dataset_path,
                "datasets/cloud_curl_dataset.csv",
            )
            lease.renew()
            upload_result(
                service,
                args.processed_container,
                summary_path,
                "datasets/cloud_capture_summary.csv",
            )
        print(f"Uploaded CSV outputs to Azure container: {args.processed_container}")
    else:
        tombstones = load_profile_tombstones(service, args.processed_container)
        filtered_summaries = filter_retained_rows(
            filter_tombstoned_rows(candidate_summaries, tombstones),
            args.derived_retention_days,
        )
        filtered_rep_rows = filter_retained_rows(
            filter_tombstoned_rows(candidate_rep_rows, tombstones),
            args.derived_retention_days,
        )
        write_csv(summary_path, CAPTURE_FIELDS, filtered_summaries)
        write_csv(dataset_path, REP_FIELDS, filtered_rep_rows)

    print(f"Wrote {summary_path}")
    print(f"Wrote {dataset_path}")
    print(f"New captures processed: {len(summaries)}")
    print(f"Retained captures in dataset: {len(filtered_summaries)}")
    print(f"Retained rep attempts in dataset: {len(filtered_rep_rows)}")
    removed_for_privacy = (len(candidate_summaries) - len(filtered_summaries)) + (
        len(candidate_rep_rows) - len(filtered_rep_rows)
    )
    if removed_for_privacy:
        print(f"Rows excluded by deletion or retention policy: {removed_for_privacy}")

    if failures:
        print(f"Skipped dataset upload because {failures} capture(s) failed; local partial CSV files were kept.")

    return 2 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
