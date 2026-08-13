from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import mimetypes
import os
from pathlib import Path
import re
from typing import Any

from azure.core.exceptions import ResourceExistsError
from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient, ContentSettings
from dotenv import load_dotenv


PLACEHOLDER_MARKERS = ("your_", "your-", "<", "example", "replace_me")


def is_configured_value(value: str) -> bool:
    cleaned = value.strip().lower()
    return bool(cleaned) and not any(marker in cleaned for marker in PLACEHOLDER_MARKERS)


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def safe_segment(value: Any, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip()).strip("_")
    return slug or fallback


@dataclass(frozen=True)
class AzureCaptureConfig:
    storage_account_name: str
    capture_container: str = "captures"
    processed_container: str = "processed"
    connection_string: str = ""

    @property
    def configured(self) -> bool:
        return is_configured_value(self.connection_string) or is_configured_value(
            self.storage_account_name
        )

    @property
    def account_url(self) -> str:
        return f"https://{self.storage_account_name}.blob.core.windows.net"


def load_azure_capture_config() -> AzureCaptureConfig:
    load_dotenv()
    return AzureCaptureConfig(
        storage_account_name=os.getenv("AZURE_STORAGE_ACCOUNT_NAME", "").strip(),
        capture_container=os.getenv("AZURE_CAPTURE_CONTAINER", "captures").strip() or "captures",
        processed_container=os.getenv("AZURE_PROCESSED_CONTAINER", "processed").strip() or "processed",
        connection_string=os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip(),
    )


def create_blob_service(config: AzureCaptureConfig) -> BlobServiceClient:
    if is_configured_value(config.connection_string):
        return BlobServiceClient.from_connection_string(config.connection_string)
    if not is_configured_value(config.storage_account_name):
        raise RuntimeError("Set AZURE_STORAGE_ACCOUNT_NAME in .env before uploading.")
    credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
    return BlobServiceClient(account_url=config.account_url, credential=credential)


def capture_prefix(metadata: dict[str, Any]) -> str:
    return "/".join(
        [
            safe_segment(metadata.get("label"), "unlabeled"),
            safe_segment(metadata.get("camera_angle"), "unknown"),
            safe_segment(metadata.get("session_id"), "session"),
            safe_segment(metadata.get("capture_id"), "capture"),
        ]
    )


def ensure_container(service: BlobServiceClient, container_name: str) -> None:
    try:
        service.create_container(container_name)
    except ResourceExistsError:
        pass


def upload_file(
    service: BlobServiceClient,
    container_name: str,
    blob_name: str,
    local_path: Path,
    content_type: str,
) -> None:
    with local_path.open("rb") as data:
        service.get_blob_client(container_name, blob_name).upload_blob(
            data,
            overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )


def upload_capture(
    video_path: Path,
    metadata_path: Path,
    *,
    config: AzureCaptureConfig | None = None,
    service: BlobServiceClient | None = None,
) -> dict[str, str]:
    """Upload a recorded workout and its complete local data bundle to Azure Blob."""
    config = config or load_azure_capture_config()
    if not config.configured:
        raise RuntimeError("Azure capture storage is not configured in .env.")
    if not video_path.is_file() or not metadata_path.is_file():
        raise FileNotFoundError("The recording video and metadata must exist before upload.")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    prefix = capture_prefix(metadata)
    video_blob = f"{prefix}/{video_path.name}"
    metadata_blob = f"{prefix}/metadata.json"
    rep_path = metadata_path.parent / str(metadata.get("rep_data_file", "reps.csv"))
    rep_blob = f"{prefix}/reps.csv" if rep_path.is_file() else ""

    metadata.update(
        {
            "azure_blob_prefix": prefix,
            "video_blob": video_blob,
            "metadata_blob": metadata_blob,
            "rep_data_blob": rep_blob,
            "azure_storage_account": config.storage_account_name,
            "azure_capture_container": config.capture_container,
            "upload_status": "uploading",
        }
    )
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    service = service or create_blob_service(config)
    ensure_container(service, config.capture_container)
    video_type = mimetypes.guess_type(video_path.name)[0] or "application/octet-stream"
    upload_file(service, config.capture_container, video_blob, video_path, video_type)
    if rep_blob:
        upload_file(service, config.capture_container, rep_blob, rep_path, "text/csv")

    uploaded_at = datetime.now(timezone.utc).isoformat()
    metadata["upload_status"] = "uploaded"
    metadata["uploaded_at"] = uploaded_at
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    upload_file(service, config.capture_container, metadata_blob, metadata_path, "application/json")

    ensure_container(service, config.processed_container)
    manifest_blob = f"manifests/{prefix}.json"
    manifest = {
        "capture_id": metadata.get("capture_id", ""),
        "session_id": metadata.get("session_id", ""),
        "exercise": metadata.get("exercise", ""),
        "label": metadata.get("label", ""),
        "camera_angle": metadata.get("camera_angle", ""),
        "video_blob": video_blob,
        "metadata_blob": metadata_blob,
        "rep_data_blob": rep_blob,
        "registered_at": uploaded_at,
        "status": "uploaded",
    }
    service.get_blob_client(config.processed_container, manifest_blob).upload_blob(
        json.dumps(manifest, indent=2),
        overwrite=True,
        content_settings=ContentSettings(content_type="application/json"),
    )
    return {
        "video_blob": video_blob,
        "metadata_blob": metadata_blob,
        "rep_data_blob": rep_blob,
        "manifest_blob": manifest_blob,
    }
