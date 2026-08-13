from __future__ import annotations

import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import retry_worker  # noqa: E402
import upload_segment  # noqa: E402


class RetryWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        self.recordings_root = Path(self.temp_dir.name).resolve()
        self.root_patch = patch.object(retry_worker, "RECORDINGS_ROOT", self.recordings_root)
        self.upload_root_patch = patch.object(
            upload_segment,
            "RECORDINGS_ROOT",
            self.recordings_root,
        )
        self.root_patch.start()
        self.upload_root_patch.start()

    def tearDown(self) -> None:
        self.root_patch.stop()
        self.upload_root_patch.stop()
        self.temp_dir.cleanup()

    def stream_directory(self) -> Path:
        stream_directory = self.recordings_root / (
            "ajc_session__p_profile__r_0__s_0__m_0"
            "__e_2000000000__n_AbCdEfGhIjKlMnOpQrStUvWx"
            "__h_deadbeefdeadbeefdeadbeefdeadbeef"
        )
        stream_directory.mkdir(parents=True, exist_ok=True)
        return stream_directory

    def test_queue_existing_segments_marks_closed_startup_files(self) -> None:
        segment = self.stream_directory() / "segment.mp4"
        segment.write_bytes(b"video")

        retry_worker.queue_existing_segments()

        self.assertFalse(segment.exists())
        self.assertEqual(segment.with_name("segment.mp4.retry").read_bytes(), b"video")

    def test_retry_once_ignores_plain_mp4_and_uploads_retry_marker(self) -> None:
        stream_directory = self.stream_directory()
        active_segment = stream_directory / "active.mp4"
        retry_segment = stream_directory / "complete.mp4.retry"
        active_segment.write_bytes(b"still recording")
        retry_segment.write_bytes(b"complete")

        with patch.object(retry_worker, "recover_stale_claims"), patch.object(
            retry_worker, "claim_and_upload", return_value=True
        ) as upload:
            retry_worker.retry_once()

        upload.assert_called_once_with(retry_segment, stream_directory.name)
        self.assertTrue(active_segment.exists())

    def test_recover_stale_claim_queues_it_for_retry(self) -> None:
        claimed_segment = self.stream_directory() / "segment.mp4.uploading"
        claimed_segment.write_bytes(b"video")
        os.utime(claimed_segment, (100, 100))

        retry_worker.recover_stale_claims(now=100 + retry_worker.STALE_CLAIM_SECONDS)

        self.assertFalse(claimed_segment.exists())
        self.assertEqual(claimed_segment.with_name("segment.mp4.retry").read_bytes(), b"video")

    def test_recover_stale_claim_tolerates_a_completed_race(self) -> None:
        claimed_segment = self.stream_directory() / "segment.mp4.uploading"
        missing_file_root = Mock()
        missing_file_root.rglob.return_value = [claimed_segment]

        with patch.object(retry_worker, "RECORDINGS_ROOT", missing_file_root):
            retry_worker.recover_stale_claims(now=100 + retry_worker.STALE_CLAIM_SECONDS)

        self.assertFalse(claimed_segment.exists())

    def test_recover_stale_claim_preserves_an_existing_retry_file(self) -> None:
        stream_directory = self.stream_directory()
        claimed_segment = stream_directory / "segment.mp4.uploading"
        retry_segment = stream_directory / "segment.mp4.retry"
        claimed_segment.write_bytes(b"second video")
        retry_segment.write_bytes(b"first video")
        os.utime(claimed_segment, (100, 100))

        retry_worker.recover_stale_claims(now=100 + retry_worker.STALE_CLAIM_SECONDS)

        self.assertEqual(retry_segment.read_bytes(), b"first video")
        self.assertEqual((stream_directory / "segment_1.mp4.retry").read_bytes(), b"second video")

    def test_purge_removes_expired_retry_and_claim_but_not_active_segment(self) -> None:
        stream_directory = self.stream_directory()
        retry_segment = stream_directory / "expired.mp4.retry"
        claimed_segment = stream_directory / "expired-claim.mp4.uploading"
        active_segment = stream_directory / "active.mp4"
        recent_retry = stream_directory / "recent.mp4.retry"
        for segment in (retry_segment, claimed_segment, active_segment, recent_retry):
            segment.write_bytes(b"private video")
        os.utime(retry_segment, (100, 100))
        os.utime(claimed_segment, (100, 100))
        os.utime(active_segment, (100, 100))
        os.utime(recent_retry, (190, 190))

        with patch.object(retry_worker, "FAILED_SEGMENT_RETENTION_SECONDS", 50):
            removed = retry_worker.purge_expired_segments(now=200)

        self.assertEqual(removed, 2)
        self.assertFalse(retry_segment.exists())
        self.assertFalse(claimed_segment.exists())
        self.assertTrue(active_segment.exists())
        self.assertTrue(recent_retry.exists())

    def test_startup_queues_existing_files_then_purges(self) -> None:
        with patch.object(retry_worker, "queue_existing_segments") as queue, patch.object(
            retry_worker, "purge_expired_segments"
        ) as purge:
            result = retry_worker.main(["--queue-existing"])

        self.assertEqual(result, 0)
        queue.assert_called_once_with()
        purge.assert_called_once_with()

    def test_worker_writes_liveness_heartbeat(self) -> None:
        heartbeat = self.recordings_root / ".retry-worker-heartbeat"

        retry_worker.write_heartbeat()

        self.assertTrue(heartbeat.is_file())


if __name__ == "__main__":
    unittest.main()
