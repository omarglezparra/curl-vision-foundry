from __future__ import annotations

from io import BytesIO
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import MagicMock, patch
from urllib import error, parse


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import upload_segment  # noqa: E402
from stream_contract import signature_for_prefix  # noqa: E402


class UploadSegmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        self.recordings_root = (Path(self.temp_dir.name) / "recordings").resolve()
        self.recordings_root.mkdir()
        self.root_patch = patch.object(upload_segment, "RECORDINGS_ROOT", self.recordings_root)
        self.root_patch.start()

    def tearDown(self) -> None:
        self.root_patch.stop()
        self.temp_dir.cleanup()

    def segment(self, name: str = "segment.mp4") -> Path:
        stream_directory = self.recordings_root / "stream"
        stream_directory.mkdir(parents=True, exist_ok=True)
        segment = stream_directory / name
        segment.write_bytes(b"video")
        return segment

    @staticmethod
    def expired_signed_stream_id() -> str:
        prefix = (
            "ajc_expired_session__p_expired_profile__r_0__s_0__m_0"
            "__e_1700000000__n_AbCdEfGhIjKlMnOpQrStUvWx"
        )
        return f"{prefix}__h_{signature_for_prefix(prefix, 'test-stream-secret')}"

    def test_failed_hook_upload_is_marked_for_retry(self) -> None:
        segment = self.segment()

        with patch.object(upload_segment, "upload_claimed_segment", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                upload_segment.claim_and_upload(segment, "stream")

        self.assertFalse(segment.exists())
        self.assertEqual(segment.with_name("segment.mp4.retry").read_bytes(), b"video")
        self.assertFalse(segment.with_name("segment.mp4.uploading").exists())

    def test_successful_retry_removes_the_segment(self) -> None:
        retry_segment = self.segment("segment.mp4.retry")

        with patch.object(upload_segment, "upload_claimed_segment") as upload:
            uploaded = upload_segment.claim_and_upload(retry_segment, "stream", "2m")

        self.assertTrue(uploaded)
        upload.assert_called_once_with(retry_segment.with_name("segment.mp4.uploading"), "stream", "2m")
        self.assertFalse(retry_segment.exists())
        self.assertFalse(retry_segment.with_name("segment.mp4.uploading").exists())

    def test_existing_claim_is_not_overwritten(self) -> None:
        retry_segment = self.segment("segment.mp4.retry")
        claimed_segment = retry_segment.with_name("segment.mp4.uploading")
        claimed_segment.write_bytes(b"in flight")

        with patch.object(upload_segment, "upload_claimed_segment") as upload:
            uploaded = upload_segment.claim_and_upload(retry_segment, "stream")

        self.assertFalse(uploaded)
        upload.assert_not_called()
        self.assertEqual(retry_segment.read_bytes(), b"video")
        self.assertEqual(claimed_segment.read_bytes(), b"in flight")

    def test_outside_recording_root_is_rejected(self) -> None:
        outside_segment = Path(self.temp_dir.name) / "outside-segment.mp4"
        outside_segment.write_bytes(b"video")

        self.assertFalse(upload_segment.segment_path_is_safe(outside_segment))

    def test_expired_stream_metadata_can_upload_a_delayed_segment(self) -> None:
        claimed_segment = self.segment("segment.mp4.uploading")
        response = MagicMock()
        response.status = 201
        response.__enter__.return_value = response
        response.read.return_value = b""

        with patch.object(upload_segment, "AZURE_API_BASE", "https://example.invalid/api"), patch.object(
            upload_segment, "AZURE_INGEST_API_TOKEN", "t" * 32
        ), patch.object(upload_segment, "STREAM_KEY_SECRET", "test-stream-secret"), patch.object(
            upload_segment.request, "urlopen", return_value=response
        ) as urlopen:
            upload_segment.upload_claimed_segment(
                claimed_segment,
                self.expired_signed_stream_id(),
                "2m",
            )

        upload_request = urlopen.call_args.args[0]
        query = parse.parse_qs(parse.urlparse(upload_request.full_url).query)
        self.assertEqual(query["session_id"], ["expired_session"])
        self.assertEqual(query["profile_id"], ["expired_profile"])
        self.assertEqual(query["captured_at"], [str(int(claimed_segment.stat().st_mtime))])

    def test_capture_timestamp_uses_original_segment_mtime(self) -> None:
        claimed_segment = self.segment("segment.mp4.uploading")
        os.utime(claimed_segment, (1_700_000_123, 1_700_000_123))
        response = MagicMock()
        response.status = 201
        response.__enter__.return_value = response
        response.read.return_value = b""

        with patch.object(upload_segment, "AZURE_API_BASE", "https://example.invalid/api"), patch.object(
            upload_segment, "AZURE_INGEST_API_TOKEN", "t" * 32
        ), patch.object(upload_segment, "STREAM_KEY_SECRET", "test-stream-secret"), patch.object(
            upload_segment.request, "urlopen", return_value=response
        ) as urlopen:
            upload_segment.upload_claimed_segment(
                claimed_segment,
                self.expired_signed_stream_id(),
            )

        upload_request = urlopen.call_args.args[0]
        query = parse.parse_qs(parse.urlparse(upload_request.full_url).query)
        self.assertEqual(query["captured_at"], ["1700000123"])

    def test_profile_deleted_response_is_removed_without_retry(self) -> None:
        segment = self.segment()
        http_error = error.HTTPError(
            "https://example.invalid/api/mentra-video",
            410,
            "Gone",
            hdrs=None,
            fp=BytesIO(b'{"error":"profile deleted"}'),
        )

        with patch.object(upload_segment, "AZURE_API_BASE", "https://example.invalid/api"), patch.object(
            upload_segment, "AZURE_INGEST_API_TOKEN", "t" * 32
        ), patch.object(upload_segment, "STREAM_KEY_SECRET", "test-stream-secret"), patch.object(
            upload_segment.request, "urlopen", side_effect=http_error
        ):
            handled = upload_segment.claim_and_upload(
                segment,
                self.expired_signed_stream_id(),
            )

        self.assertTrue(handled)
        self.assertFalse(segment.exists())
        self.assertFalse(segment.with_name("segment.mp4.retry").exists())
        self.assertFalse(segment.with_name("segment.mp4.uploading").exists())
        self.assertFalse(segment.parent.exists())

    def test_ingest_token_rejects_short_and_placeholder_values(self) -> None:
        self.assertFalse(upload_segment.ingest_token_is_valid("short"))
        self.assertFalse(upload_segment.ingest_token_is_valid("replace-with-a-random-token-value-123"))
        self.assertFalse(upload_segment.ingest_token_is_valid("your_example_token_value_1234567890"))
        self.assertTrue(upload_segment.ingest_token_is_valid("a" * 32))


if __name__ == "__main__":
    unittest.main()
