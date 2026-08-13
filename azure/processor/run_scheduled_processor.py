from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from azure.core.exceptions import HttpResponseError, ResourceExistsError
from azure.storage.blob import BlobServiceClient, ContentSettings
from dotenv import load_dotenv

from azure_capture_uploader import AzureCaptureConfig, create_blob_service


PROCESSOR_RUN_LOCK_BLOB = "privacy/processor-run.lock"
PROCESSOR_RUN_LOCK_SECONDS = 60
PROCESSOR_RUN_RENEW_SECONDS = 20


def processor_command(arguments: list[str]) -> list[str]:
    script = Path(__file__).with_name("process_azure_captures.py")
    return [sys.executable, str(script), *arguments]


@contextmanager
def processor_run_lease(
    service: BlobServiceClient,
    processed_container: str,
) -> Iterator[object | None]:
    """Yield one renewable lease, or None when another execution owns it."""
    try:
        service.create_container(processed_container)
    except ResourceExistsError:
        pass

    lock_blob = service.get_blob_client(processed_container, PROCESSOR_RUN_LOCK_BLOB)
    try:
        lock_blob.upload_blob(
            b"",
            overwrite=False,
            content_settings=ContentSettings(content_type="application/octet-stream"),
        )
    except ResourceExistsError:
        pass

    try:
        lease = lock_blob.acquire_lease(lease_duration=PROCESSOR_RUN_LOCK_SECONDS)
    except HttpResponseError as exc:
        if exc.status_code == 409:
            yield None
            return
        raise

    stop_renewal = threading.Event()
    renewal_errors: list[Exception] = []

    def renew_until_stopped() -> None:
        while not stop_renewal.wait(PROCESSOR_RUN_RENEW_SECONDS):
            try:
                lease.renew()
            except Exception as exc:  # surfaced to the supervising loop below
                renewal_errors.append(exc)
                stop_renewal.set()

    renewal_thread = threading.Thread(
        target=renew_until_stopped,
        name="processor-lease-renewal",
        daemon=True,
    )
    renewal_thread.start()
    try:
        yield (lease, renewal_errors)
    finally:
        stop_renewal.set()
        renewal_thread.join(timeout=5)
        try:
            lease.release()
        except HttpResponseError:
            # A lost/expired lease is already safe to leave released.
            pass


def run(arguments: list[str]) -> int:
    load_dotenv()
    config = AzureCaptureConfig(
        storage_account_name=os.getenv("AZURE_STORAGE_ACCOUNT_NAME", "").strip(),
        capture_container=os.getenv("AZURE_CAPTURE_CONTAINER", "captures").strip(),
        processed_container=os.getenv("AZURE_PROCESSED_CONTAINER", "processed").strip(),
        connection_string=os.getenv("AZURE_STORAGE_CONNECTION_STRING", "").strip(),
    )
    if not config.configured:
        raise RuntimeError("AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_CONNECTION_STRING is required.")

    service = create_blob_service(config)
    with processor_run_lease(service, config.processed_container) as lease_state:
        if lease_state is None:
            print("Another processor execution owns the run lease; skipping this schedule.")
            return 0

        _, renewal_errors = lease_state
        process = subprocess.Popen(processor_command(arguments))
        while process.poll() is None:
            if renewal_errors:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise RuntimeError(f"Processor run lease renewal failed: {renewal_errors[0]}")
            time.sleep(5)
        if renewal_errors:
            raise RuntimeError(f"Processor run lease renewal failed: {renewal_errors[0]}")
        return int(process.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
