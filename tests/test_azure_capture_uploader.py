from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from azure_capture_uploader import (  # noqa: E402
    AzureCaptureConfig,
    capture_prefix,
    is_configured_value,
    upload_capture,
)


class FakeBlobClient:
    def __init__(self, uploads: dict[tuple[str, str], bytes], container: str, blob: str):
        self.uploads = uploads
        self.container = container
        self.blob = blob

    def upload_blob(self, data, **_kwargs) -> None:
        payload = data.read() if hasattr(data, "read") else data
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        self.uploads[(self.container, self.blob)] = payload


class FakeBlobService:
    def __init__(self):
        self.containers: set[str] = set()
        self.uploads: dict[tuple[str, str], bytes] = {}

    def create_container(self, name: str) -> None:
        self.containers.add(name)

    def get_blob_client(self, container: str, blob: str) -> FakeBlobClient:
        return FakeBlobClient(self.uploads, container, blob)


class AzureCaptureUploaderTests(unittest.TestCase):
    def test_placeholder_values_are_not_configured(self) -> None:
        self.assertFalse(is_configured_value(""))
        self.assertFalse(is_configured_value("your_storage_account"))
        self.assertTrue(is_configured_value("curlvision12345678"))

    def test_capture_prefix_sanitizes_user_metadata(self) -> None:
        prefix = capture_prefix(
            {
                "label": "good form",
                "camera_angle": "front/left",
                "session_id": "session:1",
                "capture_id": "capture?2",
            }
        )
        self.assertEqual(prefix, "good_form/front_left/session_1/capture_2")

    def test_upload_capture_saves_complete_bundle_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            video_path = root / "video.mp4"
            metadata_path = root / "metadata.json"
            reps_path = root / "reps.csv"
            video_path.write_bytes(b"video-data")
            reps_path.write_text("session_id,rep_number\nsession_1,1\n", encoding="utf-8")
            metadata_path.write_text(
                json.dumps(
                    {
                        "capture_id": "capture_1",
                        "session_id": "session_1",
                        "exercise": "biceps_curl",
                        "label": "unlabeled",
                        "camera_angle": "front",
                        "video_file": "video.mp4",
                        "rep_data_file": "reps.csv",
                    }
                ),
                encoding="utf-8",
            )
            service = FakeBlobService()
            config = AzureCaptureConfig(storage_account_name="curlvision12345678")

            result = upload_capture(
                video_path,
                metadata_path,
                config=config,
                service=service,  # type: ignore[arg-type]
            )

            self.assertEqual(service.containers, {"captures", "processed"})
            self.assertIn(("captures", result["video_blob"]), service.uploads)
            self.assertIn(("captures", result["metadata_blob"]), service.uploads)
            self.assertIn(("captures", result["rep_data_blob"]), service.uploads)
            self.assertIn(("processed", result["manifest_blob"]), service.uploads)
            saved_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(saved_metadata["upload_status"], "uploaded")
            self.assertTrue(saved_metadata["uploaded_at"])


if __name__ == "__main__":
    unittest.main()
