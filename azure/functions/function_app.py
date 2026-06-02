from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)


app = func.FunctionApp()


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def cors_headers(origin: str | None = None) -> dict[str, str]:
    allowed = [item.strip() for item in setting("ALLOWED_ORIGINS", "").split(",") if item.strip()]
    allow_origin = origin if origin in allowed else (allowed[0] if allowed else "*")
    return {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
    }


def json_response(payload: dict, status_code: int = 200, origin: str | None = None) -> func.HttpResponse:
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
        headers=cors_headers(origin),
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
    service.create_container(container, exist_ok=True)

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


@app.route(route="health", methods=["GET", "OPTIONS"])
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
        session_id = body["session_id"]
        label = body["label"]
        camera_angle = body.get("camera_angle", "unknown")
        capture_id = body.get("capture_id") or str(uuid.uuid4())
    except (KeyError, ValueError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    safe_prefix = f"{label}/{camera_angle}/{session_id}/{capture_id}"
    container = setting("CAPTURE_CONTAINER", "captures")
    video = create_upload_blob(container, f"{safe_prefix}/video.webm", "video/webm")
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


@app.route(route="register-capture", methods=["POST", "OPTIONS"])
def register_capture(req: func.HttpRequest) -> func.HttpResponse:
    origin = req.headers.get("Origin")
    if req.method == "OPTIONS":
        return func.HttpResponse(status_code=204, headers=cors_headers(origin))

    try:
        body = req.get_json()
        capture_id = body["capture_id"]
        session_id = body["session_id"]
        label = body["label"]
        camera_angle = body.get("camera_angle", "unknown")
        video_blob = body["video_blob"]
        metadata_blob = body["metadata_blob"]
    except (KeyError, ValueError) as exc:
        return json_response({"error": f"Invalid request body: {exc}"}, status_code=400, origin=origin)

    processed_container = setting("PROCESSED_CONTAINER", "processed")
    service = blob_service()
    service.create_container(processed_container, exist_ok=True)
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
