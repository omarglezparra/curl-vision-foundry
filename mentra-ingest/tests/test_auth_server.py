from __future__ import annotations

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sys
from threading import Thread
import time
import unittest
from unittest.mock import patch
from urllib import error, request


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import auth_server  # noqa: E402
from stream_contract import signature_for_prefix  # noqa: E402


class AuthServerTests(unittest.TestCase):
    secret = "test-stream-secret"

    def setUp(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), auth_server.AuthHandler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}/auth"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def signed_stream_id(self, expires_at: int) -> str:
        prefix = (
            "ajc_session__p_profile__r_0__s_0__m_0"
            f"__e_{expires_at}__n_AbCdEfGhIjKlMnOpQrStUvWx"
        )
        return f"{prefix}__h_{signature_for_prefix(prefix, self.secret)}"

    def authorize(self, stream_id: str) -> int:
        body = json.dumps({"action": "publish", "path": f"live/{stream_id}"}).encode()
        auth_request = request.Request(
            self.url,
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with request.urlopen(auth_request, timeout=2) as response:
            response.read()
            return response.status

    def test_unexpired_publish_is_authorized(self) -> None:
        now = int(time.time())
        with patch.object(auth_server, "STREAM_KEY_SECRET", self.secret), patch.object(
            auth_server, "STREAM_AUTH_MAX_TTL_SECONDS", 300
        ), patch.object(
            auth_server, "STREAM_AUTH_CLOCK_SKEW_SECONDS", 0
        ):
            self.assertEqual(self.authorize(self.signed_stream_id(now + 60)), 200)

    def test_expired_or_excessive_publish_window_is_rejected(self) -> None:
        now = int(time.time())
        with patch.object(auth_server, "STREAM_KEY_SECRET", self.secret), patch.object(
            auth_server, "STREAM_AUTH_MAX_TTL_SECONDS", 300
        ), patch.object(
            auth_server, "STREAM_AUTH_CLOCK_SKEW_SECONDS", 0
        ):
            for expires_at in (now - 1, now + 600):
                with self.subTest(expires_at=expires_at), self.assertRaises(error.HTTPError) as raised:
                    self.authorize(self.signed_stream_id(expires_at))
                self.assertEqual(raised.exception.code, 401)


if __name__ == "__main__":
    unittest.main()
