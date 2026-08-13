from __future__ import annotations

import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import healthcheck  # noqa: E402


class HealthcheckTests(unittest.TestCase):
    def test_port_must_be_in_tcp_range(self) -> None:
        self.assertEqual(healthcheck.positive_port("1936"), 1936)
        for value in ("0", "65536"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                healthcheck.positive_port(value)

    def test_plain_mode_checks_the_rtmp_listener(self) -> None:
        connection = MagicMock()
        with patch.dict(
            os.environ,
            {"INGEST_HEALTHCHECK_MODE": "rtmp", "INGEST_HEALTHCHECK_PORT": "1935"},
            clear=True,
        ), patch.object(healthcheck.socket, "create_connection", return_value=connection) as connect:
            healthcheck.check_media_listener()

        connect.assert_called_once_with(("127.0.0.1", 1935), timeout=3)
        connection.__enter__.assert_called_once()

    def test_rtmps_mode_verifies_public_chain_and_hostname(self) -> None:
        connection = MagicMock()
        connected_socket = MagicMock()
        connection.__enter__.return_value = connected_socket
        context = MagicMock()
        context.wrap_socket.return_value = MagicMock()

        with patch.dict(
            os.environ,
            {
                "INGEST_HEALTHCHECK_MODE": "rtmps",
                "INGEST_HEALTHCHECK_PORT": "1936",
                "RTMPS_DOMAIN": "ingest.example.com",
            },
            clear=True,
        ), patch.object(
            healthcheck.socket, "create_connection", return_value=connection
        ) as connect, patch.object(healthcheck.ssl, "create_default_context", return_value=context):
            healthcheck.check_media_listener()

        connect.assert_called_once_with(("127.0.0.1", 1936), timeout=3)
        context.wrap_socket.assert_called_once_with(
            connected_socket,
            server_hostname="ingest.example.com",
        )

    def test_rtmps_mode_requires_a_dns_name(self) -> None:
        with patch.dict(
            os.environ,
            {"INGEST_HEALTHCHECK_MODE": "rtmps", "RTMPS_DOMAIN": ""},
            clear=True,
        ), self.assertRaisesRegex(ValueError, "RTMPS_DOMAIN"):
            healthcheck.check_media_listener()

    def test_retry_worker_heartbeat_must_be_fresh(self) -> None:
        with TemporaryDirectory() as temp_directory:
            heartbeat = Path(temp_directory) / "retry-heartbeat"
            heartbeat.write_text("", encoding="utf-8")
            os.utime(heartbeat, (100, 100))
            with patch.dict(
                os.environ,
                {
                    "RETRY_WORKER_HEARTBEAT_PATH": str(heartbeat),
                    "RETRY_WORKER_HEALTH_MAX_AGE_SECONDS": "300",
                },
                clear=True,
            ):
                healthcheck.check_retry_worker(now=400)
                with self.assertRaisesRegex(RuntimeError, "stale"):
                    healthcheck.check_retry_worker(now=401)

    def test_retry_worker_heartbeat_is_required(self) -> None:
        with TemporaryDirectory() as temp_directory, patch.dict(
            os.environ,
            {"RETRY_WORKER_HEARTBEAT_PATH": str(Path(temp_directory) / "missing")},
            clear=True,
        ), self.assertRaisesRegex(RuntimeError, "missing"):
            healthcheck.check_retry_worker()


if __name__ == "__main__":
    unittest.main()
