from __future__ import annotations

import hashlib
import mimetypes
import os
from pathlib import Path
import re
import sys
from urllib import error, parse, request
import uuid

from stream_contract import parse_signed_stream_path


RECORDINGS_ROOT = Path(os.getenv("RECORDINGS_ROOT", "/recordings")).resolve()
AZURE_API_BASE = os.getenv("AZURE_CAPTURE_API_BASE", "").strip().rstrip("/")
AZURE_INGEST_API_TOKEN = os.getenv("AZURE_INGEST_API_TOKEN", "").strip()
STREAM_KEY_SECRET = os.getenv("STREAM_KEY_SECRET", "").strip()
RETRY_SUFFIX = ".retry"
CLAIM_SUFFIX = ".uploading"
ERASE_CHUNK_BYTES = 1024 * 1024


class ProfileDeletedUploadError(RuntimeError):
    """The destination profile is gone, so this segment must never be retried."""


def ingest_token_is_valid(token: str) -> bool:
    placeholder = re.search(
        r"(?:replace[-_ ]|your[-_ ]|example|<[^>]+>)",
        token,
        re.IGNORECASE,
    )
    return len(token) >= 32 and placeholder is None


def validate_upload_configuration() -> None:
    if not AZURE_API_BASE:
        raise RuntimeError("AZURE_CAPTURE_API_BASE must be configured.")
    if not ingest_token_is_valid(AZURE_INGEST_API_TOKEN):
        raise RuntimeError(
            "AZURE_INGEST_API_TOKEN must be a non-placeholder value of at least 32 characters."
        )
    if not STREAM_KEY_SECRET:
        raise RuntimeError("STREAM_KEY_SECRET must be configured.")


def safe_file_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", value).strip("_")[:80]
    return cleaned or "segment"


def segment_path_is_safe(path: Path) -> bool:
    try:
        path.resolve().relative_to(RECORDINGS_ROOT)
    except ValueError:
        return False
    return path.is_file()


def prune_empty_recording_parents(directory: Path) -> None:
    """Remove empty per-stream directories without ever removing the volume root."""
    try:
        current = directory.resolve()
        current.relative_to(RECORDINGS_ROOT)
    except (FileNotFoundError, ValueError):
        return
    while current != RECORDINGS_ROOT:
        try:
            current.rmdir()
        except (FileNotFoundError, OSError):
            return
        current = current.parent


def remove_local_segment(path: Path, *, overwrite_first: bool) -> bool:
    """Remove a segment and clean up its empty credential-bearing directories.

    Overwriting is defense in depth for ordinary filesystems. Applications
    cannot guarantee physical erasure on copy-on-write filesystems, SSDs, or
    retained snapshots, so production storage must also be encrypted and have
    an appropriate snapshot/decommissioning policy.
    """
    if not path.exists():
        return False
    if not segment_path_is_safe(path):
        raise ValueError("Segment path is outside the recording volume or is not a file.")

    overwrite_failed = False
    if overwrite_first and not path.is_symlink():
        try:
            remaining = path.stat().st_size
            zero_chunk = b"\0" * min(ERASE_CHUNK_BYTES, max(remaining, 1))
            with path.open("r+b", buffering=0) as segment_file:
                segment_file.seek(0)
                while remaining:
                    write_size = min(remaining, len(zero_chunk))
                    segment_file.write(zero_chunk[:write_size])
                    remaining -= write_size
                segment_file.flush()
                os.fsync(segment_file.fileno())
        except FileNotFoundError:
            return False
        except OSError:
            # Unlinking still prevents application-level access. The warning is
            # intentionally path-free because the parent directory is a secret.
            overwrite_failed = True

    try:
        path.unlink()
    except FileNotFoundError:
        return False
    prune_empty_recording_parents(path.parent)
    if overwrite_failed:
        print("Warning: local segment was unlinked but its overwrite pass failed.", flush=True)
    return True


def original_segment_path(path: Path) -> Path:
    name = path.name
    if name.endswith(RETRY_SUFFIX):
        name = name.removesuffix(RETRY_SUFFIX)
    elif name.endswith(CLAIM_SUFFIX):
        name = name.removesuffix(CLAIM_SUFFIX)
    return path.with_name(name)


def retry_path_for_segment(path: Path) -> Path:
    original_path = original_segment_path(path)
    return original_path.with_name(f"{original_path.name}{RETRY_SUFFIX}")


def available_retry_path(path: Path) -> Path:
    original_path = original_segment_path(path)
    retry_path = retry_path_for_segment(original_path)
    counter = 1
    while retry_path.exists():
        retry_path = original_path.with_name(
            f"{original_path.stem}_{counter}{original_path.suffix}{RETRY_SUFFIX}"
        )
        counter += 1
    return retry_path


def claimed_path_for_segment(path: Path) -> Path:
    original_path = original_segment_path(path)
    return original_path.with_name(f"{original_path.name}{CLAIM_SUFFIX}")


def multipart_body(file_path: Path, request_id: str) -> tuple[bytes, str]:
    boundary = f"ai-javier-{uuid.uuid4().hex}"
    filename = original_segment_path(file_path).name
    content_type = mimetypes.guess_type(filename)[0] or "video/mp4"
    chunks = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"requestId\"\r\n\r\n{request_id}\r\n".encode(),
        (
            f"--{boundary}\r\n"
            f"Content-Disposition: form-data; name=\"video\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode(),
        file_path.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    return b"".join(chunks), boundary


def upload_claimed_segment(claimed_path: Path, stream_path: str, duration: str = "") -> None:
    validate_upload_configuration()
    metadata = parse_signed_stream_path(stream_path, STREAM_KEY_SECRET)
    original_name = original_segment_path(claimed_path).name
    fingerprint = hashlib.sha256(f"{metadata.stream_id}:{original_name}".encode()).hexdigest()[:10]
    capture_id = safe_file_id(f"segment_{Path(original_name).stem}_{fingerprint}")
    captured_at = max(0, int(claimed_path.stat().st_mtime))
    query = parse.urlencode(
        {
            "session_id": metadata.session_id,
            "capture_id": capture_id,
            "profile_id": metadata.profile_id,
            "exercise": "biceps_curl",
            "arm": "auto",
            "rotation_degrees": metadata.rotation_degrees,
            "scene_reflected": str(metadata.scene_reflected).lower(),
            "source_pixels_mirrored": str(metadata.source_pixels_mirrored).lower(),
            "segment_duration": duration,
            "captured_at": captured_at,
        }
    )
    body, boundary = multipart_body(claimed_path, capture_id)
    upload_request = request.Request(
        f"{AZURE_API_BASE}/mentra-video?{query}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {AZURE_INGEST_API_TOKEN}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    try:
        with request.urlopen(upload_request, timeout=180) as response:
            if response.status == 410:
                response.read()
                raise ProfileDeletedUploadError("Azure rejected a capture for a deleted profile.")
            if not 200 <= response.status < 300:
                raise RuntimeError(f"Azure upload returned HTTP {response.status}.")
            response.read()
    except error.HTTPError as exc:
        exc.read()
        if exc.code == 410:
            raise ProfileDeletedUploadError(
                "Azure rejected a capture for a deleted profile."
            ) from exc
        raise RuntimeError(f"Azure upload returned HTTP {exc.code}.") from exc


def claim_and_upload(segment_path: Path, stream_path: str, duration: str = "") -> bool:
    if not segment_path_is_safe(segment_path):
        raise ValueError("Segment path is outside the recording volume or is not a file.")
    claimed_path = claimed_path_for_segment(segment_path)
    if claimed_path.exists():
        return False
    try:
        segment_path.replace(claimed_path)
    except FileNotFoundError:
        return False
    try:
        upload_claimed_segment(claimed_path, stream_path, duration)
    except ProfileDeletedUploadError:
        remove_local_segment(claimed_path, overwrite_first=True)
        print("Discarded a local segment because its Azure profile was deleted.", flush=True)
        return True
    except Exception:
        if claimed_path.exists():
            claimed_path.replace(available_retry_path(segment_path))
        raise
    remove_local_segment(claimed_path, overwrite_first=False)
    print(
        f"Uploaded and removed segment {safe_file_id(original_segment_path(segment_path).stem)}",
        flush=True,
    )
    return True


def main(argv: list[str]) -> int:
    if argv[1:] == ["--check-config"]:
        try:
            validate_upload_configuration()
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr, flush=True)
            return 1
        return 0
    if len(argv) < 3:
        print(
            "usage: upload_segment.py <stream-path> <segment-path> [duration] | --check-config",
            file=sys.stderr,
        )
        return 2
    try:
        uploaded = claim_and_upload(Path(argv[2]), argv[1], argv[3] if len(argv) > 3 else "")
        return 0 if uploaded else 3
    except Exception as exc:
        print(f"Segment upload retained for retry: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
