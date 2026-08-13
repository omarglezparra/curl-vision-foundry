from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os

from stream_contract import authorize_publish_stream_path


HOST = "127.0.0.1"
PORT = int(os.getenv("AUTH_PORT", "9080"))
MIN_STREAM_AUTH_TTL_SECONDS = 300
MAX_STREAM_AUTH_TTL_SECONDS = 14_400
STREAM_KEY_SECRET = os.getenv("STREAM_KEY_SECRET", "").strip()
STREAM_AUTH_MAX_TTL_SECONDS = int(os.getenv("STREAM_AUTH_MAX_TTL_SECONDS", "14400"))
STREAM_AUTH_CLOCK_SKEW_SECONDS = int(os.getenv("STREAM_AUTH_CLOCK_SKEW_SECONDS", "60"))


class AuthHandler(BaseHTTPRequestHandler):
    server_version = "AIJavierIngestAuth/1"
    timeout = 10

    def log_message(self, format: str, *args: object) -> None:
        # Avoid writing signed stream paths or request credentials to logs.
        return

    def _json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/health":
            self._json(200 if STREAM_KEY_SECRET else 503, {"status": "ok" if STREAM_KEY_SECRET else "unconfigured"})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/auth":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16_384:
                raise ValueError("Invalid authorization payload length.")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Authorization payload must be an object.")
            if body.get("action") != "publish":
                raise ValueError("Only publishing is allowed.")
            authorize_publish_stream_path(
                str(body.get("path") or ""),
                STREAM_KEY_SECRET,
                max_future_seconds=STREAM_AUTH_MAX_TTL_SECONDS,
                future_clock_skew_seconds=STREAM_AUTH_CLOCK_SKEW_SECONDS,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            self._json(401, {"error": "unauthorized"})
            return
        self._json(200, {"status": "authorized"})


def main() -> int:
    if not STREAM_KEY_SECRET:
        raise RuntimeError("STREAM_KEY_SECRET is required.")
    if not MIN_STREAM_AUTH_TTL_SECONDS <= STREAM_AUTH_MAX_TTL_SECONDS <= MAX_STREAM_AUTH_TTL_SECONDS:
        raise RuntimeError("STREAM_AUTH_MAX_TTL_SECONDS must be between 300 and 14400.")
    if not 0 <= STREAM_AUTH_CLOCK_SKEW_SECONDS <= 300:
        raise RuntimeError("STREAM_AUTH_CLOCK_SKEW_SECONDS must be between 0 and 300.")
    ThreadingHTTPServer((HOST, PORT), AuthHandler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
