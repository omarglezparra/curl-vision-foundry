from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from winrt.windows.devices.bluetooth import BluetoothLEDevice


def pnp_bv_devices() -> list[dict[str, str]]:
    command = [
        "powershell",
        "-NoProfile",
        "-Command",
        (
            "Get-PnpDevice -Class Bluetooth | "
            "Where-Object { $_.FriendlyName -match 'BV|HeyCyan|Blackview' } | "
            "ForEach-Object { "
            "$id=$_.InstanceId; "
            "$props=Get-PnpDeviceProperty -InstanceId $id; "
            "$btle=($props | Where-Object { $_.Data -like 'BluetoothLE#*' } | Select-Object -First 1 -ExpandProperty Data); "
            "$addr=($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Bluetooth_DeviceAddress' } | Select-Object -First 1 -ExpandProperty Data); "
            "[PSCustomObject]@{Name=$_.FriendlyName; InstanceId=$id; DeviceId=$btle; Address=$addr; Status=$_.Status} "
            "} | ConvertTo-Json -Compress"
        ),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return []

    if result.returncode != 0 or not result.stdout.strip():
        return []

    payload = json.loads(result.stdout)
    if isinstance(payload, dict):
        payload = [payload]
    return [
        {
            "name": item.get("Name", ""),
            "instance_id": item.get("InstanceId", ""),
            "device_id": item.get("DeviceId") or "",
            "address": item.get("Address") or "",
            "status": item.get("Status", ""),
        }
        for item in payload
    ]


def choose_device_id(requested: str = "") -> str:
    if requested:
        return requested
    for device in pnp_bv_devices():
        if device["device_id"]:
            return device["device_id"]
    raise RuntimeError(
        "No paired BV100/HeyCyan Bluetooth LE device was found. "
        "Pair the glasses in Windows or pass --device-id."
    )


async def inspect_device(device_id: str) -> dict:
    device = await BluetoothLEDevice.from_id_async(device_id)
    if device is None:
        raise RuntimeError(f"Windows could not open BLE device id: {device_id}")

    services_result = await device.get_gatt_services_async()
    services = []
    writable = []
    notifying = []

    for service in services_result.services:
        service_item = {"uuid": str(service.uuid), "characteristics": []}
        char_result = await service.get_characteristics_async()
        for char in char_result.characteristics:
            props = int(char.characteristic_properties)
            item = {
                "uuid": str(char.uuid),
                "properties": props,
                "read": bool(props & 0x02),
                "write": bool(props & 0x04 or props & 0x08),
                "notify": bool(props & 0x10 or props & 0x20),
            }
            service_item["characteristics"].append(item)
            if item["write"]:
                writable.append(item["uuid"])
            if item["notify"]:
                notifying.append(item["uuid"])
        services.append(service_item)

    return {
        "ok": True,
        "name": device.name,
        "device_id": device_id,
        "address": f"{int(device.bluetooth_address):012x}",
        "connection_status": int(device.connection_status),
        "services_status": int(services_result.status),
        "service_count": len(services),
        "services": services,
        "writable_characteristics": writable,
        "notify_characteristics": notifying,
    }


def json_response(handler: BaseHTTPRequestHandler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class BridgeHandler(BaseHTTPRequestHandler):
    device_id = ""

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} - {format % args}")

    def do_OPTIONS(self) -> None:
        json_response(self, {"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/health":
            json_response(
                self,
                {
                    "ok": True,
                    "bridge": "windows_bv100_bridge",
                    "device_id": self.device_id,
                    "devices": pnp_bv_devices(),
                },
            )
            return

        if parsed.path == "/devices":
            json_response(self, {"ok": True, "devices": pnp_bv_devices()})
            return

        if parsed.path == "/connect":
            requested = query.get("device_id", [""])[0]
            device_id = choose_device_id(requested or self.device_id)
            try:
                payload = asyncio.run(inspect_device(device_id))
                json_response(self, payload)
            except Exception as exc:
                json_response(self, {"ok": False, "error": str(exc), "device_id": device_id}, status=500)
            return

        json_response(self, {"ok": False, "error": "Not found"}, status=404)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Expose Windows BV100/HeyCyan BLE status to Android Emulator.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device-id", default="", help="Windows BluetoothLE#... device id. Auto-detects BV/HeyCyan names by default.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    BridgeHandler.device_id = choose_device_id(args.device_id)
    print("BV100 bridge starting")
    print(f"Device ID: {BridgeHandler.device_id}")
    print(f"Host URL : http://{args.host}:{args.port}")
    print("Emulator : http://10.0.2.2:8765")
    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping bridge")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
