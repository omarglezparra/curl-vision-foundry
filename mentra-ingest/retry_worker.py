from __future__ import annotations

import os
from pathlib import Path
import sys
import time

from upload_segment import (
    CLAIM_SUFFIX,
    RECORDINGS_ROOT,
    RETRY_SUFFIX,
    available_retry_path,
    claim_and_upload,
    remove_local_segment,
)


INTERVAL_SECONDS = max(int(os.getenv("RETRY_INTERVAL_SECONDS", "60")), 10)
STALE_CLAIM_SECONDS = max(int(os.getenv("STALE_CLAIM_SECONDS", "300")), 60)
MIN_FAILED_SEGMENT_RETENTION_SECONDS = 300
MAX_FAILED_SEGMENT_RETENTION_SECONDS = 7 * 24 * 60 * 60


def bounded_seconds(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer.") from exc
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum} seconds.")
    return value


FAILED_SEGMENT_RETENTION_SECONDS = bounded_seconds(
    "FAILED_SEGMENT_RETENTION_SECONDS",
    24 * 60 * 60,
    MIN_FAILED_SEGMENT_RETENTION_SECONDS,
    MAX_FAILED_SEGMENT_RETENTION_SECONDS,
)


def stream_path_for_segment(segment_path: Path) -> str:
    return segment_path.resolve().relative_to(RECORDINGS_ROOT).parent.as_posix()


def heartbeat_path() -> Path:
    configured = os.getenv("RETRY_WORKER_HEARTBEAT_PATH", "").strip()
    return Path(configured) if configured else RECORDINGS_ROOT / ".retry-worker-heartbeat"


def write_heartbeat() -> None:
    path = heartbeat_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)


def purge_expired_segments(now: float | None = None) -> int:
    """Securely remove failed or abandoned claims after the bounded retention."""
    current_time = time.time() if now is None else now
    removed = 0
    for suffix in (RETRY_SUFFIX, CLAIM_SUFFIX):
        for segment_path in RECORDINGS_ROOT.rglob(f"*.mp4{suffix}"):
            try:
                if current_time - segment_path.stat().st_mtime < FAILED_SEGMENT_RETENTION_SECONDS:
                    continue
                if remove_local_segment(segment_path, overwrite_first=True):
                    removed += 1
            except FileNotFoundError:
                # Upload hooks and retry recovery can complete concurrently.
                continue
    if removed:
        print(f"Purged {removed} expired local segment(s).", flush=True)
    return removed


def recover_stale_claims(now: float | None = None) -> None:
    current_time = time.time() if now is None else now
    for claimed_path in RECORDINGS_ROOT.rglob(f"*.mp4{CLAIM_SUFFIX}"):
        try:
            if current_time - claimed_path.stat().st_mtime < STALE_CLAIM_SECONDS:
                continue
            claimed_path.replace(available_retry_path(claimed_path))
        except FileNotFoundError:
            # Another upload can finish while the retry scan is in progress.
            continue


def queue_existing_segments() -> None:
    """Mark segments left by an earlier container run as safe to retry.

    This must run before MediaMTX starts. A live recorder writes directly to an
    ``.mp4`` path, so the long-running retry loop must never scan plain MP4s.
    """
    RECORDINGS_ROOT.mkdir(parents=True, exist_ok=True)
    for segment_path in RECORDINGS_ROOT.rglob("*.mp4"):
        try:
            segment_path.replace(available_retry_path(segment_path))
        except FileNotFoundError:
            continue


def retry_once() -> None:
    current_time = time.time()
    write_heartbeat()
    purge_expired_segments(now=current_time)
    recover_stale_claims(now=current_time)
    for segment_path in sorted(RECORDINGS_ROOT.rglob(f"*.mp4{RETRY_SUFFIX}")):
        write_heartbeat()
        try:
            claim_and_upload(segment_path, stream_path_for_segment(segment_path))
        except Exception as exc:
            print(f"Retry deferred: {type(exc).__name__}: {exc}", flush=True)
        finally:
            write_heartbeat()


def sleep_until_next_retry() -> None:
    """Keep liveness fresh even when an operator configures a long interval."""
    deadline = time.monotonic() + INTERVAL_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 30))
        write_heartbeat()


def main(argv: list[str] | None = None) -> int:
    if argv == ["--queue-existing"]:
        queue_existing_segments()
        purge_expired_segments()
        return 0
    if argv:
        print("usage: retry_worker.py [--queue-existing]", file=sys.stderr)
        return 2
    RECORDINGS_ROOT.mkdir(parents=True, exist_ok=True)
    write_heartbeat()
    while True:
        retry_once()
        sleep_until_next_retry()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
