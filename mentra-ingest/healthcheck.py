from __future__ import annotations

import os
from pathlib import Path
import socket
import ssl
import time
from urllib import request


AUTH_HEALTH_URL = "http://127.0.0.1:9080/health"
DEFAULT_RETRY_HEARTBEAT_PATH = "/recordings/.retry-worker-heartbeat"


def positive_port(value: str) -> int:
    port = int(value)
    if not 1 <= port <= 65_535:
        raise ValueError("Healthcheck port is outside the TCP port range.")
    return port


def check_auth_server() -> None:
    with request.urlopen(AUTH_HEALTH_URL, timeout=3) as response:
        if response.status != 200:
            raise RuntimeError(f"Authorization healthcheck returned HTTP {response.status}.")
        response.read()


def check_media_listener() -> None:
    mode = os.getenv("INGEST_HEALTHCHECK_MODE", "rtmp").strip().lower()
    default_port = "1936" if mode == "rtmps" else "1935"
    port = positive_port(os.getenv("INGEST_HEALTHCHECK_PORT", default_port))

    if mode == "rtmp":
        with socket.create_connection(("127.0.0.1", port), timeout=3):
            return
    if mode != "rtmps":
        raise ValueError("INGEST_HEALTHCHECK_MODE must be rtmp or rtmps.")

    domain = os.getenv("RTMPS_DOMAIN", "").strip().rstrip(".")
    if not domain or any(character in domain for character in "/:@"):
        raise ValueError("RTMPS_DOMAIN must be the certificate DNS name.")

    context = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        with context.wrap_socket(connection, server_hostname=domain):
            return


def check_retry_worker(now: float | None = None) -> None:
    path = Path(
        os.getenv("RETRY_WORKER_HEARTBEAT_PATH", DEFAULT_RETRY_HEARTBEAT_PATH).strip()
        or DEFAULT_RETRY_HEARTBEAT_PATH
    )
    try:
        max_age = int(os.getenv("RETRY_WORKER_HEALTH_MAX_AGE_SECONDS", "300"))
    except ValueError as exc:
        raise ValueError("RETRY_WORKER_HEALTH_MAX_AGE_SECONDS must be an integer.") from exc
    if not 30 <= max_age <= 86_400:
        raise ValueError("RETRY_WORKER_HEALTH_MAX_AGE_SECONDS must be from 30 to 86400.")
    try:
        modified_at = path.stat().st_mtime
    except FileNotFoundError as exc:
        raise RuntimeError("Retry worker heartbeat is missing.") from exc
    if not path.is_file():
        raise RuntimeError("Retry worker heartbeat is not a file.")
    current_time = time.time() if now is None else now
    if current_time - modified_at > max_age:
        raise RuntimeError("Retry worker heartbeat is stale.")


def main() -> int:
    check_auth_server()
    check_media_listener()
    check_retry_worker()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
