from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from dotenv import load_dotenv

from azure_capture_uploader import create_blob_service, env_bool, is_configured_value, load_azure_capture_config


REQUIRED_MODULES = {
    "cv2": "OpenCV",
    "mediapipe": "MediaPipe",
    "numpy": "NumPy",
    "pandas": "pandas",
    "sklearn": "scikit-learn",
    "azure.ai.projects": "Azure AI Projects",
    "azure.identity": "Azure Identity",
    "azure.storage.blob": "Azure Blob Storage",
}


def check_local_environment() -> bool:
    print(f"Python {sys.version.split()[0]}")
    failures: list[str] = []

    for module_name, display_name in REQUIRED_MODULES.items():
        try:
            module = importlib.import_module(module_name)
            version = getattr(module, "__version__", "installed")
            print(f"[OK] {display_name}: {version}")
        except Exception as exc:  # Import errors can include binary load failures.
            failures.append(f"{display_name}: {exc}")
            print(f"[FAIL] {display_name}: {exc}")

    if failures:
        print("\nEnvironment check failed. Reinstall with: pip install -r requirements.txt")
        return False

    print("\nLocal AI Javier Coach environment is ready.")
    return True


def check_glasses_environment() -> bool:
    vendor = os.getenv("GLASSES_VENDOR", "").strip().lower()
    model = os.getenv("GLASSES_MODEL", "").strip().upper()
    alias = os.getenv("GLASSES_ALIAS", "").strip().lower()
    transport = os.getenv("GLASSES_TRANSPORT", "").strip().lower()

    if (vendor, model, alias, transport) != ("mentra", "LIVE01", "ml1", "bluetooth"):
        print("[FAIL] Smart glasses: expected Mentra LIVE01 (alias ml1) over Bluetooth.")
        return False

    print("[OK] Smart glasses: Mentra Live / LIVE01 (ml1), Bluetooth transport")
    if not os.getenv("MENTRAOS_API_KEY", "").strip():
        print("[INFO] MENTRAOS_API_KEY is blank; direct Bluetooth mode does not require it.")
    return True


def check_capture_environment() -> bool:
    output_paths = [
        Path(os.getenv("CAPTURE_LOG_PATH", "outputs/curl_reps.csv")).parent,
        Path(os.getenv("CAPTURE_VIDEO_DIR", "outputs/session_videos")),
    ]
    try:
        for path in output_paths:
            path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        print(f"[FAIL] Capture outputs are not writable: {exc}")
        return False

    print(f"[OK] Capture exercise: {os.getenv('CAPTURE_EXERCISE', 'biceps_curl')}")
    print(f"[OK] Capture source: {os.getenv('CAPTURE_SOURCE', '0')}")
    azure_config = load_azure_capture_config()
    if env_bool("AZURE_AUTO_UPLOAD", default=False) and not azure_config.configured:
        print("[INFO] Azure auto-upload is waiting for AZURE_STORAGE_ACCOUNT_NAME.")
    elif azure_config.configured:
        print(f"[OK] Azure capture target: {azure_config.storage_account_name}/{azure_config.capture_container}")
    return True


def check_azure_cli() -> tuple[bool, dict]:
    az_executable = shutil.which("az") or shutil.which("az.cmd")
    if not az_executable:
        print("[FAIL] Azure CLI is not installed.")
        return False, {}
    result = subprocess.run(
        [az_executable, "account", "show", "--output", "json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print("[FAIL] Azure CLI is signed out. Run: az login")
        return False, {}
    account = json.loads(result.stdout)
    expected_subscription = os.getenv("AZURE_SUBSCRIPTION_ID", "").strip()
    expected_tenant = os.getenv("AZURE_TENANT_ID", "").strip()
    expected_user = os.getenv("AZURE_ACCOUNT_EMAIL", "").strip().lower()
    if is_configured_value(expected_subscription) and account.get("id") != expected_subscription:
        print("[FAIL] Azure CLI subscription does not match AZURE_SUBSCRIPTION_ID.")
        return False, account
    if is_configured_value(expected_tenant) and account.get("tenantId") != expected_tenant:
        print("[FAIL] Azure CLI tenant does not match AZURE_TENANT_ID.")
        return False, account
    signed_in_user = str(account.get("user", {}).get("name", "")).lower()
    if is_configured_value(expected_user) and signed_in_user != expected_user:
        print("[FAIL] Azure CLI account does not match AZURE_ACCOUNT_EMAIL.")
        return False, account
    print(f"[OK] Azure CLI: {account.get('name', account.get('id', 'signed in'))}")
    return True, account


def check_azure_client() -> bool:
    from azure.ai.projects import AIProjectClient
    from azure.core.rest import HttpRequest
    from azure.identity import DefaultAzureCredential

    cli_ready, _ = check_azure_cli()
    ready = cli_ready

    storage_config = load_azure_capture_config()
    if not storage_config.configured:
        print("[FAIL] Set AZURE_STORAGE_ACCOUNT_NAME in .env.")
        ready = False
    elif cli_ready:
        try:
            service = create_blob_service(storage_config)
            service.get_container_client(storage_config.capture_container).get_container_properties()
            print(f"[OK] Azure Blob: {storage_config.storage_account_name}/{storage_config.capture_container}")
        except Exception as exc:
            print(f"[FAIL] Azure Blob access: {type(exc).__name__}: {exc}")
            ready = False

    endpoint = (
        os.getenv("FOUNDRY_PROJECT_ENDPOINT", "").strip()
        or os.getenv("AZURE_AI_PROJECT_ENDPOINT", "").strip()
    )
    endpoint_pattern = r"^https://[A-Za-z0-9-]+\.services\.ai\.azure\.com/api/projects/[A-Za-z0-9_.-]+/?$"
    if not is_configured_value(endpoint) or not re.match(endpoint_pattern, endpoint):
        print("[FAIL] Set a valid FOUNDRY_PROJECT_ENDPOINT in .env.")
        ready = False
    elif cli_ready:
        credential = None
        client = None
        try:
            credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
            client = AIProjectClient(endpoint=endpoint, credential=credential)
            request = HttpRequest("GET", f"{endpoint.rstrip('/')}/connections?api-version=v1")
            response = client.send_request(request)
            response.raise_for_status()
            print("[OK] Microsoft Foundry project access")
        except Exception as exc:
            print(f"[FAIL] Microsoft Foundry access: {type(exc).__name__}: {exc}")
            ready = False
        finally:
            if client:
                client.close()
            if credential:
                credential.close()
    return ready


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify the AI Javier Coach environment.")
    parser.add_argument("--azure", action="store_true", help="Also verify Azure client configuration.")
    args = parser.parse_args()

    load_dotenv()
    ready = check_local_environment() and check_glasses_environment() and check_capture_environment()
    if args.azure:
        ready = check_azure_client() and ready
    return 0 if ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
