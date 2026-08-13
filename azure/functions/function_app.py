from __future__ import annotations

import csv
from contextlib import contextmanager
import hmac
import io
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)
from azure.core.exceptions import HttpResponseError, ResourceExistsError, ResourceNotFoundError


app = func.FunctionApp()


MINIAPP_PROFILE_ID_PATTERN = re.compile(r"^mp_[a-f0-9]{24}$")
WEB_PROFILE_ID_PATTERN = re.compile(r"^web_[a-f0-9]{32}$")
PROFILE_DATASET_BLOBS = (
    "datasets/cloud_capture_summary.csv",
    "datasets/cloud_curl_dataset.csv",
)
PROFILE_TOMBSTONE_PREFIX = "privacy/deleted-profiles"
DATASET_WRITE_LOCK_BLOB = "privacy/dataset-write.lock"
DATASET_LOCK_SECONDS = 60
DATASET_LOCK_WAIT_SECONDS = 30


def safe_segment(value: object, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip()).strip("_")
    return slug or fallback


def ensure_container(service: BlobServiceClient, container: str) -> None:
    try:
        service.create_container(container)
    except ResourceExistsError:
        pass


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def cors_headers(origin: str | None = None) -> dict[str, str]:
    allowed = [item.strip() for item in setting("ALLOWED_ORIGINS", "").split(",") if item.strip()]
    allow_origin = origin if origin in allowed else (allowed[0] if allowed else "*")
    return {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400",
    }


def json_response(
    payload: dict,
    status_code: int = 200,
    origin: str | None = None,
    extra_headers: dict[str, str] | None = None,
) -> func.HttpResponse:
    headers = cors_headers(origin)
    if extra_headers:
        headers.update(extra_headers)
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
        headers=headers,
    )


def blob_service() -> BlobServiceClient:
    connection_string = setting("CAPTURE_STORAGE_CONNECTION_STRING") or setting("AzureWebJobsStorage")
    return BlobServiceClient.from_connection_string(connection_string)


def account_key_from_connection_string(connection_string: str) -> str:
    for part in connection_string.split(";"):
        if part.startswith("AccountKey="):
            return part.split("=", 1)[1]
    raise ValueError("Storage connection string must include AccountKey for SAS generation.")


def account_name_from_connection_string(connection_string: str) -> str:
    for part in connection_string.split(";"):
        if part.startswith("AccountName="):
            return part.split("=", 1)[1]
    raise ValueError("Storage connection string must include AccountName for SAS generation.")


def create_upload_blob(container: str, blob_name: str, content_type: str) -> dict[str, str]:
    connection_string = setting("CAPTURE_STORAGE_CONNECTION_STRING") or setting("AzureWebJobsStorage")
    service = BlobServiceClient.from_connection_string(connection_string)
    ensure_container(service, container)

    account_name = account_name_from_connection_string(connection_string)
    account_key = account_key_from_connection_string(connection_string)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=30)
    sas = generate_blob_sas(
        account_name=account_name,
        container_name=container,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(create=True, write=True),
        expiry=expires_at,
        content_type=content_type,
    )
    url = f"https://{account_name}.blob.core.windows.net/{container}/{blob_name}?{sas}"
    return {"blobName": blob_name, "uploadUrl": url, "expiresAt": expires_at.isoformat()}


def video_extension(mime_type: str, requested_extension: str = "") -> str:
    extension = requested_extension.lower().strip().lstrip(".")
    if extension in {"avi", "m4v", "mkv", "mov", "mp4", "webm"}:
        return extension
    if mime_type.startswith("video/mp4"):
        return "mp4"
    if mime_type.startswith("video/quicktime"):
        return "mov"
    return "webm"


def bearer_token_matches(authorization: str | None, expected_token: str | None) -> bool:
    """Validate a Bearer token without an early token-value comparison."""
    expected = expected_token or ""
    scheme, separator, supplied = (authorization or "").partition(" ")
    valid_scheme = bool(separator) and scheme.lower() == "bearer" and bool(supplied)
    comparison_target = expected if expected else "\0"
    matches = hmac.compare_digest(supplied.encode("utf-8"), comparison_target.encode("utf-8"))
    return bool(expected) and valid_scheme and matches


def bearer_error(
    req: func.HttpRequest,
    origin: str | None,
    token_setting: str,
) -> func.HttpResponse | None:
    expected = setting(token_setting).strip()
    placeholder = re.search(r"(?:replace[-_ ]|your[-_ ]|example|<[^>]+>)", expected, re.IGNORECASE)
    if len(expected) < 32 or placeholder:
        return json_response(
            {"error": "The route API token is not securely configured."},
            status_code=503,
            origin=origin,
        )
    if not bearer_token_matches(req.headers.get("Authorization"), expected):
        return json_response(
            {"error": "A valid Bearer token is required."},
            status_code=401,
            origin=origin,
            extra_headers={"WWW-Authenticate": "Bearer"},
        )
    return None


def parse_boolean(value: object, default: bool = False) -> bool:
    if value is None or str(value).strip() == "":
        return default
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"Expected a boolean value, received {value!r}.")


def parse_rotation_degrees(value: object) -> int:
    try:
        rotation = int(str(value if value is not None else "0").strip() or "0")
    except ValueError as exc:
        raise ValueError("rotation_degrees must be 0, 90, 180, or 270.") from exc
    if rotation not in {0, 90, 180, 270}:
        raise ValueError("rotation_degrees must be 0, 90, 180, or 270.")
    return rotation


def video_geometry_metadata(
    rotation_degrees: int,
    scene_reflected: bool,
    source_pixels_mirrored: bool,
) -> dict[str, int | bool]:
    return {
        "geometry_schema_version": 1,
        "rotation_cw_to_upright": rotation_degrees,
        "scene_reflected": scene_reflected,
        "source_pixels_mirrored": source_pixels_mirrored,
        "horizontal_flip_applied": scene_reflected != source_pixels_mirrored,
    }


def build_session_status_document(
    body: object,
    updated_at: datetime | None = None,
) -> dict[str, object]:
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object.")
    session_raw = str(body.get("session_id") or "").strip()
    status_raw = str(body.get("status") or "").strip()
    if not session_raw:
        raise ValueError("session_id is required.")
    if not status_raw:
        raise ValueError("status is required.")

    session_id = safe_segment(session_raw, "session")[:128]
    profile_id = safe_segment(body.get("profile_id"), "owner")[:80]
    capture_raw = str(body.get("capture_id") or "").strip()
    stream_raw = str(body.get("stream_id") or "").strip()
    source = safe_segment(body.get("source"), "mentra_live")[:80]
    rotation_degrees = parse_rotation_degrees(body.get("rotation_degrees"))
    scene_reflected = parse_boolean(body.get("scene_reflected"), default=False)
    source_pixels_mirrored = parse_boolean(
        body.get("source_pixels_mirrored"),
        default=False,
    )
    timestamp = updated_at or parse_utc_timestamp(body.get("updated_at")) or datetime.now(timezone.utc)
    started_at = parse_utc_timestamp(body.get("started_at"))
    ended_at = parse_utc_timestamp(body.get("ended_at"))
    return {
        "schema_version": 1,
        "session_id": session_id,
        "profile_id": profile_id,
        "capture_id": safe_segment(capture_raw, "capture")[:128] if capture_raw else "",
        "status": safe_segment(status_raw, "unknown")[:80],
        "source": source,
        "stream_id": safe_segment(stream_raw, "stream")[:128] if stream_raw else "",
        "updated_at": timestamp.isoformat(),
        "started_at": started_at.isoformat() if started_at else "",
        "ended_at": ended_at.isoformat() if ended_at else "",
        "video_geometry": video_geometry_metadata(
            rotation_degrees,
            scene_reflected,
            source_pixels_mirrored,
        ),
    }


def _optional_float(value: object) -> float | None:
    try:
        raw = str(value if value is not None else "").strip()
        return float(raw) if raw else None
    except (TypeError, ValueError):
        return None


def _integer(value: object) -> int:
    number = _optional_float(value)
    return max(int(number), 0) if number is not None else 0


def _csv_rows(csv_text: str) -> list[dict[str, str]]:
    if not csv_text.strip():
        return []
    return list(csv.DictReader(io.StringIO(csv_text.lstrip("\ufeff"))))


def _warning_values(value: object) -> list[str]:
    return [item.strip() for item in str(value or "").split("|") if item.strip()]


def _rounded_average(values: list[float]) -> float:
    return round(sum(values) / len(values), 2) if values else 0.0


def _zero_overall() -> dict[str, int | float | str]:
    return {
        "sessions": 0,
        "captures": 0,
        "reps": 0,
        "goodReps": 0,
        "goodFormPercent": 0.0,
        "totalDurationSeconds": 0.0,
        "avgRangeOfMotion": 0.0,
        "avgRepSpeed": 0.0,
        "warningCount": 0,
        "latestProcessedAtUtc": "",
    }


def aggregate_performance(
    capture_summary_csv: str,
    curl_dataset_csv: str,
    recent_limit: int = 10,
    profile_id: str = "",
) -> dict[str, object]:
    """Aggregate the processor CSV outputs into dashboard-ready session metrics."""
    summary_rows = _csv_rows(capture_summary_csv)
    rep_rows = _csv_rows(curl_dataset_csv)
    if profile_id:
        summary_rows = [
            row
            for row in summary_rows
            if str(row.get("profile_id") or "owner").strip() == profile_id
        ]
        rep_rows = [
            row
            for row in rep_rows
            if str(row.get("profile_id") or "owner").strip() == profile_id
        ]
    if not summary_rows and not rep_rows:
        return {
            "status": "pending",
            "overall": _zero_overall(),
            "recentSessions": [],
            "pendingCaptures": 0,
            "dataSources": {"captureSummary": False, "curlReps": False},
        }

    sessions: dict[str, dict[str, object]] = {}

    def bucket(session_id: str) -> dict[str, object]:
        return sessions.setdefault(
            session_id,
            {
                "session_id": session_id,
                "processed_at_utc": "",
                "captures": 0,
                "duration_seconds": 0.0,
                "summary_reps": 0,
                "summary_good_reps": 0,
                "rep_rows_present": False,
                "reps": 0,
                "good_reps": 0,
                "rep_rom_values": [],
                "rep_speed_values": [],
                "summary_rom_values": [],
                "summary_speed_values": [],
                "rep_warnings": [],
                "summary_warnings": [],
            },
        )

    for row in summary_rows:
        session_id = str(row.get("session_id") or row.get("workout_id") or "").strip()
        if not session_id:
            continue
        current = bucket(session_id)
        current["captures"] = int(current["captures"]) + 1
        current["duration_seconds"] = float(current["duration_seconds"]) + (
            _optional_float(row.get("duration_seconds")) or 0.0
        )
        current["summary_reps"] = int(current["summary_reps"]) + _integer(row.get("counted_reps"))
        current["summary_good_reps"] = int(current["summary_good_reps"]) + _integer(row.get("good_reps"))
        processed_at = str(row.get("processed_at_utc") or "")
        current["processed_at_utc"] = max(str(current["processed_at_utc"]), processed_at)
        range_value = _optional_float(row.get("avg_range_of_motion"))
        speed_value = _optional_float(row.get("avg_rep_speed"))
        if range_value is not None:
            current["summary_rom_values"].append(range_value)  # type: ignore[union-attr]
        if speed_value is not None:
            current["summary_speed_values"].append(speed_value)  # type: ignore[union-attr]
        current["summary_warnings"].extend(_warning_values(row.get("form_warnings")))  # type: ignore[union-attr]

    for row in rep_rows:
        session_id = str(row.get("session_id") or row.get("workout_id") or "").strip()
        if not session_id:
            continue
        current = bucket(session_id)
        current["rep_rows_present"] = True
        processed_at = str(row.get("processed_at_utc") or "")
        current["processed_at_utc"] = max(str(current["processed_at_utc"]), processed_at)
        current["rep_warnings"].extend(_warning_values(row.get("warnings")))  # type: ignore[union-attr]
        if not parse_boolean(row.get("counted_rep"), default=False):
            continue
        current["reps"] = int(current["reps"]) + 1
        if parse_boolean(row.get("good_form"), default=False):
            current["good_reps"] = int(current["good_reps"]) + 1
        range_value = _optional_float(row.get("range_of_motion"))
        speed_value = _optional_float(row.get("rep_speed_degrees_per_second"))
        if range_value is not None:
            current["rep_rom_values"].append(range_value)  # type: ignore[union-attr]
        if speed_value is not None:
            current["rep_speed_values"].append(speed_value)  # type: ignore[union-attr]

    recent_sessions: list[dict[str, object]] = []
    overall_rom_values: list[float] = []
    overall_speed_values: list[float] = []
    for current in sessions.values():
        if not current["rep_rows_present"]:
            current["reps"] = current["summary_reps"]
            current["good_reps"] = current["summary_good_reps"]
        reps = int(current["reps"])
        good_reps = min(int(current["good_reps"]), reps) if reps else 0
        rep_rom_values = list(current["rep_rom_values"])
        rep_speed_values = list(current["rep_speed_values"])
        rom_values = rep_rom_values or list(current["summary_rom_values"])
        speed_values = rep_speed_values or list(current["summary_speed_values"])
        overall_rom_values.extend(rom_values)
        overall_speed_values.extend(speed_values)
        warning_values = (
            list(current["rep_warnings"])
            if current["rep_rows_present"]
            else list(current["summary_warnings"])
        )
        recent_sessions.append(
            {
                "sessionId": current["session_id"],
                "processedAt": current["processed_at_utc"],
                "captures": current["captures"],
                "durationSeconds": round(float(current["duration_seconds"]), 2),
                "reps": reps,
                "goodReps": good_reps,
                "goodFormPercent": round((good_reps / reps) * 100, 1) if reps else 0.0,
                "avgRangeOfMotion": _rounded_average(rom_values),
                "avgRepSpeed": _rounded_average(speed_values),
                "warningCount": len(warning_values),
                "warnings": sorted(set(warning_values)),
            }
        )

    recent_sessions.sort(
        key=lambda item: (str(item["processedAt"]), str(item["sessionId"])),
        reverse=True,
    )
    all_sessions = recent_sessions
    total_reps = sum(int(item["reps"]) for item in all_sessions)
    total_good_reps = sum(int(item["goodReps"]) for item in all_sessions)
    latest_processed = max((str(item["processedAt"]) for item in all_sessions), default="")
    overall = {
        "sessions": len(all_sessions),
        "captures": sum(int(item["captures"]) for item in all_sessions),
        "reps": total_reps,
        "goodReps": total_good_reps,
        "goodFormPercent": round((total_good_reps / total_reps) * 100, 1) if total_reps else 0.0,
        "totalDurationSeconds": round(sum(float(item["durationSeconds"]) for item in all_sessions), 2),
        "avgRangeOfMotion": _rounded_average(overall_rom_values),
        "avgRepSpeed": _rounded_average(overall_speed_values),
        "warningCount": sum(int(item["warningCount"]) for item in all_sessions),
        "latestProcessedAtUtc": latest_processed,
    }
    limit = min(max(int(recent_limit), 1), 50)
    return {
        "status": "ready",
        "overall": overall,
        "recentSessions": all_sessions[:limit],
        "pendingCaptures": 0,
        "dataSources": {
            "captureSummary": bool(summary_rows),
            "curlReps": bool(rep_rows),
        },
    }


def count_pending_captures(
    metadata_blob_names: list[str],
    capture_summary_csv: str,
    profile_id: str = "",
) -> int:
    """Count uploaded capture metadata documents not present in processed output."""
    processed_rows = _csv_rows(capture_summary_csv)
    if profile_id:
        processed_rows = [
            row
            for row in processed_rows
            if str(row.get("profile_id") or "owner").strip() == profile_id
        ]
    processed_names = {
        str(row.get("metadata_blob") or "").strip().replace("\\", "/")
        for row in processed_rows
        if str(row.get("metadata_blob") or "").strip()
    }
    processed_ids = {
        str(row.get("capture_id") or "").strip()
        for row in processed_rows
        if str(row.get("capture_id") or "").strip()
    }
    uploaded_names = {
        str(name).strip().replace("\\", "/")
        for name in metadata_blob_names
        if str(name).strip().replace("\\", "/").endswith("/metadata.json")
    }
    if profile_id:
        profile_prefix = f"profiles/{profile_id}/"
        uploaded_names = {
            name
            for name in uploaded_names
            if name.startswith(profile_prefix)
            or (profile_id == "owner" and not name.startswith("profiles/"))
        }
    pending = 0
    for name in uploaded_names:
        parts = name.split("/")
        capture_id = parts[-2] if len(parts) >= 2 else ""
        if name not in processed_names and capture_id not in processed_ids:
            pending += 1
    return pending


def download_text_if_exists(service: BlobServiceClient, container: str, blob_name: str) -> str:
    try:
        content = service.get_blob_client(container, blob_name).download_blob().readall()
    except ResourceNotFoundError:
        return ""
    if isinstance(content, bytes):
        return content.decode("utf-8-sig")
    return str(content)


def is_miniapp_profile_id(value: object) -> bool:
    """Return whether a value is one of this MiniApp's pseudonymous profile IDs."""
    return bool(MINIAPP_PROFILE_ID_PATTERN.fullmatch(str(value or "").strip()))


def is_web_profile_id(value: object) -> bool:
    """Return whether a value is a high-entropy pseudonymous web profile ID."""
    return bool(WEB_PROFILE_ID_PATTERN.fullmatch(str(value or "").strip()))


def is_ingest_profile_id(value: object) -> bool:
    """Allow the fixed direct-companion owner or a pseudonymous MiniApp profile."""
    profile_id = str(value or "").strip()
    return profile_id == "owner" or is_miniapp_profile_id(profile_id)


def parse_utc_timestamp(value: object) -> datetime | None:
    """Parse an ISO-8601 string or Unix timestamp into a UTC-aware datetime."""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        if re.fullmatch(r"\d+(?:\.\d+)?", raw):
            parsed = datetime.fromtimestamp(float(raw), tz=timezone.utc)
        else:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            parsed = parsed.astimezone(timezone.utc)
    except (OverflowError, OSError, ValueError) as exc:
        raise ValueError("Timestamp must be ISO-8601 or Unix seconds.") from exc
    return parsed


def profile_tombstone_blob_name(profile_id: str) -> str:
    if not is_miniapp_profile_id(profile_id):
        raise ValueError("profile_id must be a valid MiniApp profile identifier.")
    return f"{PROFILE_TOMBSTONE_PREFIX}/{profile_id}.json"


def profile_deleted_at(
    service: BlobServiceClient,
    processed_container: str,
    profile_id: str,
) -> datetime | None:
    raw = download_text_if_exists(
        service,
        processed_container,
        profile_tombstone_blob_name(profile_id),
    )
    if not raw:
        return None
    try:
        document = json.loads(raw)
        if not isinstance(document, dict) or document.get("profile_id") != profile_id:
            return None
        return parse_utc_timestamp(document.get("deleted_at"))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def capture_is_deleted(
    service: BlobServiceClient,
    processed_container: str,
    profile_id: str,
    captured_at: datetime | None,
) -> bool:
    # The deletion/tombstone contract is intentionally limited to pseudonymous
    # Store profiles. The separately authenticated direct companion uses the
    # fixed "owner" namespace and is not eligible for this route.
    if not is_miniapp_profile_id(profile_id):
        return False
    deleted_at = profile_deleted_at(service, processed_container, profile_id)
    return deleted_at is not None and (captured_at is None or captured_at <= deleted_at)


@contextmanager
def dataset_write_lock(
    service: BlobServiceClient,
    processed_container: str,
):
    """Serialize dataset replacement and privacy deletion with a short Blob lease."""
    ensure_container(service, processed_container)
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


def remove_profile_rows(csv_text: str, profile_id: str) -> tuple[str, int]:
    """Remove one profile's rows from a CSV while preserving its complete schema."""
    if not csv_text.strip():
        return csv_text, 0

    source = io.StringIO(csv_text.lstrip("\ufeff"))
    reader = csv.DictReader(source)
    fieldnames = reader.fieldnames
    if not fieldnames or "profile_id" not in fieldnames:
        return csv_text, 0

    kept_rows: list[dict[str, str]] = []
    removed = 0
    for row in reader:
        if str(row.get("profile_id") or "owner").strip() == profile_id:
            removed += 1
        else:
            kept_rows.append(row)

    if not removed:
        return csv_text, 0

    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(kept_rows)
    return output.getvalue(), removed


def _blob_names(
    service: BlobServiceClient,
    container: str,
    prefix: str,
) -> list[str]:
    try:
        blobs = service.get_container_client(container).list_blobs(name_starts_with=prefix)
        return [str(blob.name) for blob in blobs]
    except ResourceNotFoundError:
        return []


def load_web_workout_history(
    service: BlobServiceClient,
    container: str,
    profile_id: str,
    limit: int = 100,
) -> list[dict[str, object]]:
    """Load newest web workout statistics belonging to one pseudonymous profile."""
    if not is_web_profile_id(profile_id):
        raise ValueError("profile_id must be a valid web profile identifier.")
    safe_limit = max(1, min(int(limit), 100))
    prefix = f"profiles/{profile_id}/workout-summaries/"
    sessions: list[dict[str, object]] = []
    for blob_name in _blob_names(service, container, prefix):
        if not blob_name.endswith("/workout-summary.json"):
            continue
        try:
            raw = service.get_blob_client(container, blob_name).download_blob().readall()
            document = json.loads(raw.decode("utf-8-sig") if isinstance(raw, bytes) else str(raw))
        except (ResourceNotFoundError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(document, dict) or document.get("profile_id") != profile_id:
            continue
        statistics = document.get("statistics")
        if not isinstance(statistics, dict):
            continue
        summary = dict(statistics)
        next_session = document.get("next_session")
        if isinstance(next_session, dict) and "nextSessionPlan" not in summary:
            summary["nextSessionPlan"] = next_session
        sessions.append(summary)
    sessions.sort(key=lambda item: str(item.get("completedAt") or ""), reverse=True)
    return sessions[:safe_limit]


def _json_blob_matches_profile(
    service: BlobServiceClient,
    container: str,
    blob_name: str,
    profile_id: str,
) -> bool:
    try:
        raw = service.get_blob_client(container, blob_name).download_blob().readall()
        document = json.loads(raw.decode("utf-8-sig") if isinstance(raw, bytes) else str(raw))
    except (ResourceNotFoundError, UnicodeDecodeError, json.JSONDecodeError, TypeError):
        return False
    return isinstance(document, dict) and str(document.get("profile_id") or "").strip() == profile_id


def delete_profile_data(
    service: BlobServiceClient,
    capture_container: str,
    processed_container: str,
    profile_id: str,
    deleted_at: datetime | None = None,
) -> dict[str, int]:
    """Delete all server-side records attributable to one MiniApp profile."""
    if not is_miniapp_profile_id(profile_id):
        raise ValueError("profile_id must be a valid MiniApp profile identifier.")

    deletion_time = (deleted_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    ensure_container(service, processed_container)
    tombstone_name = profile_tombstone_blob_name(profile_id)
    service.get_blob_client(processed_container, tombstone_name).upload_blob(
        json.dumps(
            {
                "schema_version": 1,
                "profile_id": profile_id,
                "deleted_at": deletion_time.isoformat(),
            },
            indent=2,
        ),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )

    deleted = {
        "captureBlobs": 0,
        "manifestBlobs": 0,
        "processedProfileBlobs": 0,
        "sessionStatusBlobs": 0,
        "datasetRows": 0,
        "tombstoneBlobs": 1,
    }

    for blob_name in _blob_names(service, capture_container, f"profiles/{profile_id}/"):
        service.get_blob_client(capture_container, blob_name).delete_blob(delete_snapshots="include")
        deleted["captureBlobs"] += 1

    processed_prefixes = (
        (f"manifests/profiles/{profile_id}/", "manifestBlobs"),
        (f"profiles/{profile_id}/", "processedProfileBlobs"),
    )
    for prefix, counter in processed_prefixes:
        for blob_name in _blob_names(service, processed_container, prefix):
            service.get_blob_client(processed_container, blob_name).delete_blob(
                delete_snapshots="include"
            )
            deleted[counter] += 1

    for blob_name in _blob_names(service, processed_container, "sessions/"):
        if not blob_name.endswith("/status.json"):
            continue
        if not _json_blob_matches_profile(
            service,
            processed_container,
            blob_name,
            profile_id,
        ):
            continue
        service.get_blob_client(processed_container, blob_name).delete_blob(
            delete_snapshots="include"
        )
        deleted["sessionStatusBlobs"] += 1

    with dataset_write_lock(service, processed_container) as lease:
        for dataset_blob_name in PROFILE_DATASET_BLOBS:
            lease.renew()
            dataset = download_text_if_exists(service, processed_container, dataset_blob_name)
            filtered, removed = remove_profile_rows(dataset, profile_id)
            if not removed:
                continue
            service.get_blob_client(processed_container, dataset_blob_name).upload_blob(
                filtered.encode("utf-8"),
                overwrite=True,
                content_settings=ContentSettings(content_type="text/csv; charset=utf-8"),
            )
            deleted["datasetRows"] += removed

    return deleted


@app.route(route="health", methods=["GET", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    return json_response({"status": "ok"}, origin=origin)


@app.route(route="create-upload", methods=["POST", "OPTIONS"])
def create_upload(req: func.HttpRequest) -> func.HttpResponse:
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))

    try:
        body = req.get_json()
        session_id = safe_segment(body["session_id"], "session")
        label = safe_segment(body["label"], "unlabeled")
        camera_angle = safe_segment(body.get("camera_angle"), "unknown")
        capture_id = safe_segment(body.get("capture_id") or str(uuid.uuid4()), "capture")
        video_mime_type = body.get("video_mime_type", "video/webm")
        extension = video_extension(video_mime_type, body.get("video_file_extension", ""))
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    safe_prefix = f"{label}/{camera_angle}/{session_id}/{capture_id}"
    container = setting("CAPTURE_CONTAINER", "captures")
    video = create_upload_blob(container, f"{safe_prefix}/video.{extension}", video_mime_type)
    metadata = create_upload_blob(container, f"{safe_prefix}/metadata.json", "application/json")

    return json_response(
        {
            "captureId": capture_id,
            "container": container,
            "video": video,
            "metadata": metadata,
        },
        origin=origin,
    )


@app.route(route="create-summary-upload", methods=["POST", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def create_summary_upload(req: func.HttpRequest) -> func.HttpResponse:
    """Create a short-lived SAS URL for an automatic workout summary JSON."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))

    try:
        body = req.get_json()
        session_id = safe_segment(body["session_id"], "session")[:128]
        profile_id = str(body.get("profile_id") or "").strip()
        if profile_id and not is_web_profile_id(profile_id):
            raise ValueError("profile_id must be a valid web profile identifier.")
    except (AttributeError, KeyError, ValueError, TypeError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    container = setting("PROCESSED_CONTAINER", "processed")
    blob_name = (
        f"profiles/{profile_id}/workout-summaries/{session_id}/workout-summary.json"
        if profile_id
        else f"sessions/{session_id}/workout-summary.json"
    )
    upload = create_upload_blob(container, blob_name, "application/json")
    return json_response(
        {
            "status": "ready",
            "container": container,
            "blobName": blob_name,
            "uploadUrl": upload["uploadUrl"],
            "expiresAt": upload["expiresAt"],
        },
        origin=origin,
    )


@app.route(route="workout-history", methods=["POST", "OPTIONS"], auth_level=func.AuthLevel.ANONYMOUS)
def workout_history(req: func.HttpRequest) -> func.HttpResponse:
    """Return cloud summaries scoped to one unguessable pseudonymous web profile."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    try:
        body = req.get_json()
        profile_id = str(body.get("profile_id") or "").strip()
        if not is_web_profile_id(profile_id):
            raise ValueError("profile_id must be a valid web profile identifier.")
        limit = int(body.get("limit") or 100)
        if limit < 1 or limit > 100:
            raise ValueError("limit must be an integer from 1 to 100.")
    except (AttributeError, ValueError, TypeError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    sessions = load_web_workout_history(
        blob_service(),
        setting("PROCESSED_CONTAINER", "processed"),
        profile_id,
        limit,
    )
    return json_response(
        {
            "status": "ready",
            "profileId": profile_id,
            "sessions": sessions,
            "count": len(sessions),
        },
        origin=origin,
        extra_headers={"Cache-Control": "no-store"},
    )


@app.route(route="register-capture", methods=["POST", "OPTIONS"])
def register_capture(req: func.HttpRequest) -> func.HttpResponse:
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))

    try:
        body = req.get_json()
        capture_id = safe_segment(body["capture_id"], "capture")
        session_id = safe_segment(body["session_id"], "session")
        label = safe_segment(body["label"], "unlabeled")
        camera_angle = safe_segment(body.get("camera_angle"), "unknown")
        video_blob = body["video_blob"]
        metadata_blob = body["metadata_blob"]
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    processed_container = setting("PROCESSED_CONTAINER", "processed")
    service = blob_service()
    ensure_container(service, processed_container)
    manifest_blob = service.get_blob_client(
        processed_container,
        f"manifests/{label}/{camera_angle}/{session_id}/{capture_id}.json",
    )
    manifest = {
        "capture_id": capture_id,
        "session_id": session_id,
        "label": label,
        "camera_angle": camera_angle,
        "video_blob": video_blob,
        "metadata_blob": metadata_blob,
        "registered_at": datetime.now(timezone.utc).isoformat(),
        "status": "uploaded",
    }
    manifest_blob.upload_blob(
        json.dumps(manifest, indent=2),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )
    return json_response({"status": "registered", "manifest": manifest_blob.blob_name}, origin=origin)


@app.route(
    route="mentra-session",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def mentra_session(req: func.HttpRequest) -> func.HttpResponse:
    """Persist the latest recording or streaming lifecycle state for a session."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    auth_failure = bearer_error(req, origin, "AZURE_MINIAPP_API_TOKEN")
    if auth_failure:
        return auth_failure

    try:
        document = build_session_status_document(req.get_json())
    except (TypeError, ValueError) as exc:
        return json_response({"error": str(exc)}, status_code=400, origin=origin)

    profile_id = str(document["profile_id"])
    if not is_miniapp_profile_id(profile_id):
        return json_response(
            {"error": "profile_id must be a valid MiniApp profile identifier."},
            status_code=400,
            origin=origin,
        )

    processed_container = setting("PROCESSED_CONTAINER", "processed")
    service = blob_service()
    ensure_container(service, processed_container)
    activity_at = parse_utc_timestamp(document.get("started_at")) or parse_utc_timestamp(
        document.get("updated_at")
    )
    if capture_is_deleted(service, processed_container, profile_id, activity_at):
        return json_response(
            {"error": "This session predates the profile's data-deletion request."},
            status_code=410,
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )
    status_blob_name = f"sessions/{document['session_id']}/status.json"
    service.get_blob_client(processed_container, status_blob_name).upload_blob(
        json.dumps(document, indent=2),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )
    if capture_is_deleted(service, processed_container, profile_id, activity_at):
        try:
            service.get_blob_client(processed_container, status_blob_name).delete_blob(
                delete_snapshots="include"
            )
        except ResourceNotFoundError:
            pass
        return json_response(
            {"error": "This session predates the profile's data-deletion request."},
            status_code=410,
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )
    return json_response(
        {
            "status": "saved",
            "sessionId": document["session_id"],
            "captureId": document["capture_id"],
            "sessionStatus": document["status"],
            "statusBlob": status_blob_name,
        },
        origin=origin,
    )


@app.route(
    route="mentra-video",
    methods=["POST", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def mentra_video(req: func.HttpRequest) -> func.HttpResponse:
    """Receive the multipart video uploaded by Mentra Live after a recording stops."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    auth_failure = bearer_error(req, origin, "AZURE_INGEST_API_TOKEN")
    if auth_failure:
        return auth_failure

    received_at = datetime.now(timezone.utc)
    try:
        video_file = req.files.get("video")
        request_id = str(req.form.get("requestId") or "").strip()
        session_raw = str(req.params.get("session_id") or "").strip()
        if video_file is None:
            raise ValueError("multipart field 'video' is required.")
        if not request_id:
            raise ValueError("multipart field 'requestId' is required.")
        if not session_raw:
            raise ValueError("query field 'session_id' is required.")

        session_id = safe_segment(session_raw, "session")[:128]
        profile_id = str(req.params.get("profile_id") or "").strip()
        if not is_ingest_profile_id(profile_id):
            raise ValueError(
                "profile_id must be owner or a valid MiniApp profile identifier."
            )
        capture_id = safe_segment(req.params.get("capture_id") or request_id, "capture")[:128]
        exercise = safe_segment(req.params.get("exercise"), "biceps_curl")[:80]
        arm = str(req.params.get("arm") or "auto").strip().lower()
        if arm not in {"auto", "left", "right"}:
            raise ValueError("arm must be auto, left, or right.")
        rotation_degrees = parse_rotation_degrees(req.params.get("rotation_degrees"))
        scene_reflected = parse_boolean(req.params.get("scene_reflected"), default=False)
        source_pixels_mirrored = parse_boolean(
            req.params.get("source_pixels_mirrored"),
            default=False,
        )
        source_captured_at = parse_utc_timestamp(req.params.get("captured_at"))
        if source_captured_at and source_captured_at > received_at + timedelta(minutes=5):
            raise ValueError("captured_at cannot be more than five minutes in the future.")
    except ValueError as exc:
        return json_response({"error": str(exc)}, status_code=400, origin=origin)

    created_at = source_captured_at or received_at
    label = "unlabeled"
    camera_angle = "mirror_mentra" if scene_reflected else "first_person_mentra"
    prefix = f"profiles/{profile_id}/{label}/{camera_angle}/{session_id}/{capture_id}"
    video_blob_name = f"{prefix}/video.mp4"
    metadata_blob_name = f"{prefix}/metadata.json"
    content_type = getattr(video_file, "content_type", None) or "video/mp4"
    original_filename = str(getattr(video_file, "filename", "") or "video.mp4")
    metadata = {
        "schema_version": 2,
        "capture_id": capture_id,
        "session_id": session_id,
        "profile_id": profile_id,
        "workout_id": session_id,
        "request_id": request_id[:256],
        "label": label,
        "exercise": exercise,
        "arm": arm,
        "camera_angle": camera_angle,
        "capture_type": "set",
        "created_at": created_at.isoformat(),
        "source": "mentra_live",
        "source_device": "mentra_live",
        "glasses_vendor": "mentra",
        "glasses_model": "LIVE01",
        "source_filename": original_filename,
        "video_file": "video.mp4",
        "video_mime_type": content_type,
        "rotation_degrees": rotation_degrees,
        "scene_reflected": scene_reflected,
        "source_pixels_mirrored": source_pixels_mirrored,
        "preview_mirrored": False,
        "video_geometry": video_geometry_metadata(
            rotation_degrees,
            scene_reflected,
            source_pixels_mirrored,
        ),
        "training_intent": "unreviewed",
        "use_for_training": False,
        "azure_blob_prefix": prefix,
        "video_blob": video_blob_name,
        "metadata_blob": metadata_blob_name,
        "upload_status": "uploaded",
        "uploaded_at": received_at.isoformat(),
    }

    capture_container = setting("CAPTURE_CONTAINER", "captures")
    processed_container = setting("PROCESSED_CONTAINER", "processed")
    service = blob_service()
    ensure_container(service, capture_container)
    ensure_container(service, processed_container)
    if capture_is_deleted(
        service,
        processed_container,
        profile_id,
        source_captured_at,
    ):
        return json_response(
            {"error": "This capture predates the profile's data-deletion request."},
            status_code=410,
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )
    video_stream = getattr(video_file, "stream", video_file)
    if hasattr(video_stream, "seek"):
        video_stream.seek(0)
    service.get_blob_client(capture_container, video_blob_name).upload_blob(
        video_stream,
        overwrite=True,
        content_settings=ContentSettings(content_type=content_type),
    )
    service.get_blob_client(capture_container, metadata_blob_name).upload_blob(
        json.dumps(metadata, indent=2),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )

    manifest_name = f"manifests/{prefix}.json"
    manifest = {
        "capture_id": capture_id,
        "session_id": session_id,
        "profile_id": profile_id,
        "exercise": exercise,
        "label": label,
        "camera_angle": camera_angle,
        "video_blob": video_blob_name,
        "metadata_blob": metadata_blob_name,
        "registered_at": created_at.isoformat(),
        "status": "uploaded",
        "source": "mentra_live",
    }
    service.get_blob_client(processed_container, manifest_name).upload_blob(
        json.dumps(manifest, indent=2),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )
    if capture_is_deleted(
        service,
        processed_container,
        profile_id,
        source_captured_at,
    ):
        for container, blob_name in (
            (capture_container, video_blob_name),
            (capture_container, metadata_blob_name),
            (processed_container, manifest_name),
        ):
            try:
                service.get_blob_client(container, blob_name).delete_blob(delete_snapshots="include")
            except ResourceNotFoundError:
                pass
        return json_response(
            {"error": "This capture predates the profile's data-deletion request."},
            status_code=410,
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )
    return json_response(
        {
            "status": "uploaded",
            "requestId": request_id,
            "captureId": capture_id,
            "sessionId": session_id,
            "videoBlob": video_blob_name,
            "metadataBlob": metadata_blob_name,
            "manifest": manifest_name,
        },
        status_code=201,
        origin=origin,
    )


@app.route(
    route="performance",
    methods=["GET", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def performance(req: func.HttpRequest) -> func.HttpResponse:
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    try:
        recent_limit = int(str(req.params.get("limit") or "10"))
        if recent_limit < 1 or recent_limit > 50:
            raise ValueError
    except ValueError:
        return json_response(
            {"error": "limit must be an integer from 1 to 50."},
            status_code=400,
            origin=origin,
        )
    requested_profile = str(req.params.get("profile_id") or "owner").strip()
    all_profiles = requested_profile.lower() == "all"
    auth_failure = bearer_error(
        req,
        origin,
        "AZURE_PROCESSOR_API_TOKEN" if all_profiles else "AZURE_MINIAPP_API_TOKEN",
    )
    if auth_failure:
        return auth_failure
    profile_id = "all" if all_profiles else safe_segment(requested_profile, "owner")[:80]
    profile_filter = "" if all_profiles else profile_id

    processed_container = setting("PROCESSED_CONTAINER", "processed")
    service = blob_service()
    capture_summary_csv = download_text_if_exists(
        service,
        processed_container,
        "datasets/cloud_capture_summary.csv",
    )
    curl_dataset_csv = download_text_if_exists(
        service,
        processed_container,
        "datasets/cloud_curl_dataset.csv",
    )
    payload = aggregate_performance(
        capture_summary_csv,
        curl_dataset_csv,
        recent_limit,
        profile_filter,
    )
    capture_container = setting("CAPTURE_CONTAINER", "captures")
    try:
        metadata_blob_names = [
            blob.name
            for blob in service.get_container_client(capture_container).list_blobs()
            if blob.name.endswith("/metadata.json")
        ]
    except ResourceNotFoundError:
        metadata_blob_names = []
    payload["pendingCaptures"] = count_pending_captures(
        metadata_blob_names,
        capture_summary_csv,
        profile_filter,
    )
    payload["profileId"] = profile_id
    payload["generatedAtUtc"] = datetime.now(timezone.utc).isoformat()
    return json_response(payload, origin=origin)


@app.route(
    route="profile-preferences",
    methods=["GET", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def profile_preferences(req: func.HttpRequest) -> func.HttpResponse:
    """Return the saved camera geometry for one authenticated MiniApp profile."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    auth_failure = bearer_error(req, origin, "AZURE_MINIAPP_API_TOKEN")
    if auth_failure:
        return auth_failure

    profile_id = str(req.params.get("profile_id") or "").strip()
    if not is_miniapp_profile_id(profile_id):
        return json_response(
            {"error": "profile_id must be a valid MiniApp profile identifier."},
            status_code=400,
            origin=origin,
        )

    processed_container = setting("PROCESSED_CONTAINER", "processed")
    status_blob_name = f"sessions/preferences_{profile_id}/status.json"
    raw = download_text_if_exists(blob_service(), processed_container, status_blob_name)
    if not raw:
        return json_response(
            {"status": "missing", "profileId": profile_id, "geometry": None},
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )
    try:
        document = json.loads(raw)
        geometry = document.get("video_geometry") if isinstance(document, dict) else None
        if not isinstance(geometry, dict):
            raise ValueError
        rotation = parse_rotation_degrees(geometry.get("rotation_cw_to_upright"))
        scene_reflected = parse_boolean(geometry.get("scene_reflected"), default=False)
        source_pixels_mirrored = parse_boolean(
            geometry.get("source_pixels_mirrored"),
            default=False,
        )
    except (json.JSONDecodeError, TypeError, ValueError):
        return json_response(
            {"error": "Saved profile preferences are invalid."},
            status_code=500,
            origin=origin,
            extra_headers={"Cache-Control": "no-store"},
        )

    return json_response(
        {
            "status": "ready",
            "profileId": profile_id,
            "geometry": {
                "rotationDegrees": rotation,
                "sceneReflected": scene_reflected,
                "sourcePixelsMirrored": source_pixels_mirrored,
            },
            "updatedAt": str(document.get("updated_at") or ""),
        },
        origin=origin,
        extra_headers={"Cache-Control": "no-store"},
    )


@app.route(
    route="profile-data",
    methods=["DELETE", "OPTIONS"],
    auth_level=func.AuthLevel.ANONYMOUS,
)
def profile_data(req: func.HttpRequest) -> func.HttpResponse:
    """Permanently delete data associated with one pseudonymous MiniApp profile."""
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))
    auth_failure = bearer_error(req, origin, "AZURE_MINIAPP_API_TOKEN")
    if auth_failure:
        return auth_failure

    profile_id = str(req.params.get("profile_id") or "").strip()
    if not is_miniapp_profile_id(profile_id):
        return json_response(
            {"error": "profile_id must be a valid MiniApp profile identifier."},
            status_code=400,
            origin=origin,
        )

    service = blob_service()
    deleted = delete_profile_data(
        service,
        setting("CAPTURE_CONTAINER", "captures"),
        setting("PROCESSED_CONTAINER", "processed"),
        profile_id,
    )
    return json_response(
        {
            "status": "deleted",
            "profileId": profile_id,
            "deleted": deleted,
        },
        origin=origin,
        extra_headers={"Cache-Control": "no-store"},
    )
