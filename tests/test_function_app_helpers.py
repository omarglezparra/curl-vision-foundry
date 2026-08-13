from __future__ import annotations

from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


try:
    import azure
    import azure.functions as azure_functions
except ImportError:  # pragma: no cover - the deployment installs azure-functions.
    import azure
    azure_functions = None

if azure_functions is None or not hasattr(azure_functions, "FunctionApp"):
    azure_functions_stub = types.ModuleType("azure.functions")

    class FunctionAppStub:
        def route(self, **_kwargs):
            return lambda function: function

    class AuthLevelStub:
        ANONYMOUS = "anonymous"

    class HttpResponseStub:
        def __init__(self, body=None, status_code=200, mimetype=None, headers=None):
            self.body = body
            self.status_code = status_code
            self.mimetype = mimetype
            self.headers = headers or {}

    azure_functions_stub.FunctionApp = FunctionAppStub
    azure_functions_stub.AuthLevel = AuthLevelStub
    azure_functions_stub.HttpRequest = object
    azure_functions_stub.HttpResponse = HttpResponseStub
    sys.modules["azure.functions"] = azure_functions_stub
    setattr(azure, "functions", azure_functions_stub)


MODULE_PATH = Path(__file__).resolve().parents[1] / "azure" / "functions" / "function_app.py"
SPEC = importlib.util.spec_from_file_location("curl_vision_function_app", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
FUNCTION_APP = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = FUNCTION_APP
SPEC.loader.exec_module(FUNCTION_APP)


class FakeDownload:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def readall(self) -> bytes:
        return self.content


class FakeBlobClient:
    def __init__(self, service: "FakeBlobService", container: str, blob_name: str) -> None:
        self.service = service
        self.container = container
        self.blob_name = blob_name

    def download_blob(self) -> FakeDownload:
        return FakeDownload(self.service.blobs[(self.container, self.blob_name)])

    def delete_blob(self, **_kwargs) -> None:
        del self.service.blobs[(self.container, self.blob_name)]

    def upload_blob(self, data, **_kwargs) -> None:
        if _kwargs.get("overwrite") is False and (self.container, self.blob_name) in self.service.blobs:
            raise FUNCTION_APP.ResourceExistsError("Blob already exists.")
        if hasattr(data, "read"):
            data = data.read()
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.service.blobs[(self.container, self.blob_name)] = bytes(data)

    def acquire_lease(self, **_kwargs):
        return FakeLease()


class FakeLease:
    def renew(self) -> None:
        return None

    def release(self) -> None:
        return None


class FakeContainerClient:
    def __init__(self, service: "FakeBlobService", container: str) -> None:
        self.service = service
        self.container = container

    def list_blobs(self, name_starts_with: str = ""):
        return [
            types.SimpleNamespace(name=blob_name)
            for container, blob_name in sorted(self.service.blobs)
            if container == self.container and blob_name.startswith(name_starts_with)
        ]


class FakeBlobService:
    def __init__(self, blobs: dict[tuple[str, str], bytes | str]) -> None:
        self.blobs = {
            key: value.encode("utf-8") if isinstance(value, str) else value
            for key, value in blobs.items()
        }

    def create_container(self, _container: str) -> None:
        return None

    def get_blob_client(self, container: str, blob_name: str) -> FakeBlobClient:
        return FakeBlobClient(self, container, blob_name)

    def get_container_client(self, container: str) -> FakeContainerClient:
        return FakeContainerClient(self, container)


class FunctionAppAuthTests(unittest.TestCase):
    def test_bearer_token_requires_exact_token(self) -> None:
        self.assertTrue(FUNCTION_APP.bearer_token_matches("Bearer secret-token", "secret-token"))
        self.assertTrue(FUNCTION_APP.bearer_token_matches("bearer secret-token", "secret-token"))
        self.assertFalse(FUNCTION_APP.bearer_token_matches("Bearer wrong", "secret-token"))
        self.assertFalse(FUNCTION_APP.bearer_token_matches("Basic secret-token", "secret-token"))
        self.assertFalse(FUNCTION_APP.bearer_token_matches(None, "secret-token"))
        self.assertFalse(FUNCTION_APP.bearer_token_matches("Bearer secret-token", ""))

    def test_route_tokens_require_independent_non_placeholder_secrets(self) -> None:
        token = "a" * 64
        request = types.SimpleNamespace(headers={"Authorization": f"Bearer {token}"})
        with patch.dict(os.environ, {"AZURE_MINIAPP_API_TOKEN": token}, clear=False):
            self.assertIsNone(
                FUNCTION_APP.bearer_error(request, None, "AZURE_MINIAPP_API_TOKEN")
            )

        for insecure in ("short", "replace-me-with-a-very-long-example-token"):
            with patch.dict(
                os.environ,
                {"AZURE_MINIAPP_API_TOKEN": insecure},
                clear=False,
            ):
                response = FUNCTION_APP.bearer_error(
                    request,
                    None,
                    "AZURE_MINIAPP_API_TOKEN",
                )
                self.assertIsNotNone(response)
                self.assertEqual(response.status_code, 503)

    def test_geometry_value_parsers_reject_ambiguous_input(self) -> None:
        self.assertTrue(FUNCTION_APP.parse_boolean("yes"))
        self.assertFalse(FUNCTION_APP.parse_boolean("OFF", default=True))
        self.assertTrue(FUNCTION_APP.parse_boolean(None, default=True))
        with self.assertRaises(ValueError):
            FUNCTION_APP.parse_boolean("sometimes")

        for rotation in (0, 90, 180, 270):
            self.assertEqual(FUNCTION_APP.parse_rotation_degrees(str(rotation)), rotation)
        with self.assertRaises(ValueError):
            FUNCTION_APP.parse_rotation_degrees("45")

        geometry = FUNCTION_APP.video_geometry_metadata(90, True, False)
        self.assertEqual(
            geometry,
            {
                "geometry_schema_version": 1,
                "rotation_cw_to_upright": 90,
                "scene_reflected": True,
                "source_pixels_mirrored": False,
                "horizontal_flip_applied": True,
            },
        )

    def test_session_status_document_is_sanitized_and_canonical(self) -> None:
        document = FUNCTION_APP.build_session_status_document(
            {
                "session_id": "gym/session 1",
                "capture_id": "capture:1",
                "status": "streaming",
                "source": "mentra live",
                "stream_id": "stream/1",
                "rotation_degrees": 270,
                "scene_reflected": True,
                "source_pixels_mirrored": False,
            },
            updated_at=datetime(2026, 7, 30, 3, 0, tzinfo=timezone.utc),
        )

        self.assertEqual(document["session_id"], "gym_session_1")
        self.assertEqual(document["profile_id"], "owner")
        self.assertEqual(document["capture_id"], "capture_1")
        self.assertEqual(document["source"], "mentra_live")
        self.assertEqual(document["stream_id"], "stream_1")
        self.assertEqual(document["updated_at"], "2026-07-30T03:00:00+00:00")
        self.assertEqual(document["video_geometry"]["rotation_cw_to_upright"], 270)
        self.assertTrue(document["video_geometry"]["horizontal_flip_applied"])

        with self.assertRaises(ValueError):
            FUNCTION_APP.build_session_status_document({"status": "recording"})


class FunctionAppAggregationTests(unittest.TestCase):
    def test_empty_datasets_return_pending_zero_metrics(self) -> None:
        result = FUNCTION_APP.aggregate_performance("", "")

        self.assertEqual(result["status"], "pending")
        self.assertEqual(result["overall"]["sessions"], 0)
        self.assertEqual(result["overall"]["reps"], 0)
        self.assertEqual(result["recentSessions"], [])

    def test_rep_rows_override_capture_summary_counts_for_same_session(self) -> None:
        summary_csv = """processed_at_utc,session_id,capture_id,duration_seconds,counted_reps,good_reps,avg_range_of_motion,avg_rep_speed,form_warnings
2026-07-29T10:00:00Z,session-a,capture-a,60,5,4,85,110,summary_warning
2026-07-30T10:00:00Z,session-b,capture-b,30,3,3,100,90,
"""
        reps_csv = """processed_at_utc,session_id,counted_rep,good_form,range_of_motion,rep_speed_degrees_per_second,warnings
2026-07-29T10:00:01Z,session-a,True,True,90,120,
2026-07-29T10:00:02Z,session-a,True,False,80,100,torso_swing
2026-07-29T10:00:03Z,session-a,False,False,70,80,short_range
"""

        result = FUNCTION_APP.aggregate_performance(summary_csv, reps_csv, recent_limit=1)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["dataSources"], {"captureSummary": True, "curlReps": True})
        self.assertEqual(result["overall"]["sessions"], 2)
        self.assertEqual(result["overall"]["captures"], 2)
        self.assertEqual(result["overall"]["reps"], 5)
        self.assertEqual(result["overall"]["goodReps"], 4)
        self.assertEqual(result["overall"]["goodFormPercent"], 80.0)
        self.assertEqual(result["overall"]["totalDurationSeconds"], 90.0)
        self.assertEqual(result["overall"]["avgRangeOfMotion"], 90.0)
        self.assertEqual(result["overall"]["avgRepSpeed"], 103.33)
        self.assertEqual(result["overall"]["warningCount"], 2)
        self.assertEqual(len(result["recentSessions"]), 1)
        self.assertEqual(result["recentSessions"][0]["sessionId"], "session-b")

    def test_pending_capture_count_uses_metadata_name_and_capture_id(self) -> None:
        summary_csv = """capture_id,metadata_blob
capture-a,unlabeled/mirror/session-a/capture-a/metadata.json
capture-b,
"""
        uploaded = [
            "unlabeled/mirror/session-a/capture-a/metadata.json",
            "unlabeled/mirror/session-b/capture-b/metadata.json",
            "unlabeled/mirror/session-c/capture-c/metadata.json",
            "unlabeled/mirror/session-c/capture-c/metadata.json",
            "unlabeled/mirror/session-c/capture-c/video.mp4",
        ]

        self.assertEqual(
            FUNCTION_APP.count_pending_captures(uploaded, summary_csv),
            1,
        )

    def test_performance_can_be_scoped_to_a_profile(self) -> None:
        summary_csv = """profile_id,session_id,capture_id,counted_reps,good_reps
profile-a,session-a,capture-a,3,2
profile-b,session-b,capture-b,9,9
"""

        result = FUNCTION_APP.aggregate_performance(
            summary_csv,
            "",
            profile_id="profile-a",
        )

        self.assertEqual(result["overall"]["sessions"], 1)
        self.assertEqual(result["overall"]["reps"], 3)
        self.assertEqual(result["recentSessions"][0]["sessionId"], "session-a")


class FunctionAppProfileDeletionTests(unittest.TestCase):
    def test_profile_id_validation_is_narrow(self) -> None:
        self.assertTrue(FUNCTION_APP.is_miniapp_profile_id("mp_" + "a" * 24))
        for invalid in ("owner", "all", "mp_short", "mp_" + "G" * 24, "../profile"):
            self.assertFalse(FUNCTION_APP.is_miniapp_profile_id(invalid))
        self.assertTrue(FUNCTION_APP.is_ingest_profile_id("owner"))
        self.assertTrue(FUNCTION_APP.is_ingest_profile_id("mp_" + "a" * 24))
        for invalid in ("all", "profile-a", "mp_short", "../owner"):
            self.assertFalse(FUNCTION_APP.is_ingest_profile_id(invalid))

        self.assertTrue(FUNCTION_APP.is_web_profile_id("web_" + "c" * 32))
        for invalid in ("owner", "web_short", "web_" + "G" * 32, "../web_profile"):
            self.assertFalse(FUNCTION_APP.is_web_profile_id(invalid))

    def test_web_workout_history_is_profile_scoped_sorted_and_limited(self) -> None:
        target = "web_" + "a" * 32
        other = "web_" + "b" * 32
        def summary(
            profile_id: str,
            session_id: str,
            completed_at: str | None,
            reps: int,
            status: str = "completed",
        ) -> str:
            return json.dumps(
                {
                    "profile_id": profile_id,
                    "status": status,
                    "statistics": {
                        "id": session_id,
                        "completedAt": completed_at,
                        "reps": reps,
                        "status": status,
                    },
                    "next_session": {"sessionNumber": reps},
                }
            )

        service = FakeBlobService(
            {
                (
                    "processed",
                    f"profiles/{target}/workout-summaries/session-1/workout-summary.json",
                ): summary(target, "session-1", "2026-08-10T10:00:00Z", 8),
                (
                    "processed",
                    f"profiles/{target}/workout-summaries/session-2/workout-summary.json",
                ): summary(target, "session-2", "2026-08-11T10:00:00Z", 9),
                (
                    "processed",
                    f"profiles/{target}/workout-summaries/bad/workout-summary.json",
                ): b"not-json",
                (
                    "processed",
                    f"profiles/{target}/workout-summaries/active/workout-summary.json",
                ): summary(target, "active", None, 4, status="in_progress"),
                (
                    "processed",
                    f"profiles/{other}/workout-summaries/session-x/workout-summary.json",
                ): summary(other, "session-x", "2026-08-12T10:00:00Z", 12),
            }
        )

        history = FUNCTION_APP.load_web_workout_history(service, "processed", target, limit=1)

        self.assertEqual([item["id"] for item in history], ["session-2"])
        self.assertEqual(history[0]["nextSessionPlan"], {"sessionNumber": 9})
        with self.assertRaises(ValueError):
            FUNCTION_APP.load_web_workout_history(service, "processed", "owner")

    def test_csv_rows_are_removed_without_changing_other_profiles(self) -> None:
        target = "mp_" + "a" * 24
        csv_text = (
            "\ufeffprofile_id,session_id,note\r\n"
            f'{target},session-a,"keep, commas safe"\r\n'
            "mp_bbbbbbbbbbbbbbbbbbbbbbbb,session-b,retained\r\n"
        )

        filtered, removed = FUNCTION_APP.remove_profile_rows(csv_text, target)

        self.assertEqual(removed, 1)
        self.assertNotIn(target, filtered)
        self.assertIn("mp_bbbbbbbbbbbbbbbbbbbbbbbb", filtered)
        self.assertEqual(filtered.splitlines()[0], "profile_id,session_id,note")

    def test_profile_deletion_covers_captures_manifests_status_and_datasets(self) -> None:
        target = "mp_" + "a" * 24
        other = "mp_" + "b" * 24
        summary = (
            "profile_id,session_id,capture_id\n"
            f"{target},session-a,capture-a\n"
            f"{target},session-b,capture-b\n"
            f"{other},session-c,capture-c\n"
        )
        reps = (
            "profile_id,session_id,counted_rep\n"
            f"{target},session-a,True\n"
            f"{other},session-c,True\n"
        )
        service = FakeBlobService(
            {
                ("captures", f"profiles/{target}/unlabeled/front/session-a/capture-a/video.mp4"): b"video",
                ("captures", f"profiles/{target}/unlabeled/front/session-a/capture-a/metadata.json"): b"{}",
                ("captures", f"profiles/{other}/unlabeled/front/session-c/capture-c/video.mp4"): b"other",
                ("processed", f"manifests/profiles/{target}/unlabeled/front/session-a/capture-a.json"): b"{}",
                ("processed", f"manifests/profiles/{other}/unlabeled/front/session-c/capture-c.json"): b"{}",
                ("processed", f"profiles/{target}/reports/latest.json"): b"{}",
                ("processed", "sessions/session-a/status.json"): json.dumps({"profile_id": target}),
                ("processed", "sessions/session-c/status.json"): json.dumps({"profile_id": other}),
                ("processed", "sessions/broken/status.json"): b"not-json",
                ("processed", "datasets/cloud_capture_summary.csv"): summary,
                ("processed", "datasets/cloud_curl_dataset.csv"): reps,
            }
        )

        deleted = FUNCTION_APP.delete_profile_data(
            service,
            "captures",
            "processed",
            target,
        )

        self.assertEqual(
            deleted,
            {
                "captureBlobs": 2,
                "manifestBlobs": 1,
                "processedProfileBlobs": 1,
                "sessionStatusBlobs": 1,
                "datasetRows": 3,
                "tombstoneBlobs": 1,
            },
        )
        for container, blob_name in service.blobs:
            if blob_name.startswith(FUNCTION_APP.PROFILE_TOMBSTONE_PREFIX):
                continue
            self.assertNotIn(target, blob_name)
        tombstone_name = FUNCTION_APP.profile_tombstone_blob_name(target)
        self.assertIn(("processed", tombstone_name), service.blobs)
        self.assertNotIn(
            target,
            service.blobs[("processed", "datasets/cloud_capture_summary.csv")].decode("utf-8"),
        )
        self.assertNotIn(
            target,
            service.blobs[("processed", "datasets/cloud_curl_dataset.csv")].decode("utf-8"),
        )
        self.assertIn(
            ("captures", f"profiles/{other}/unlabeled/front/session-c/capture-c/video.mp4"),
            service.blobs,
        )
        self.assertIn(("processed", "sessions/session-c/status.json"), service.blobs)

    def test_profile_deletion_rejects_non_miniapp_namespaces(self) -> None:
        service = FakeBlobService({("captures", "profiles/owner/video.mp4"): b"video"})

        with self.assertRaises(ValueError):
            FUNCTION_APP.delete_profile_data(service, "captures", "processed", "owner")

        self.assertIn(("captures", "profiles/owner/video.mp4"), service.blobs)

    def test_tombstone_rejects_old_or_undated_captures_but_allows_new_data(self) -> None:
        target = "mp_" + "a" * 24
        deleted_at = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
        tombstone = json.dumps(
            {
                "schema_version": 1,
                "profile_id": target,
                "deleted_at": deleted_at.isoformat(),
            }
        )
        service = FakeBlobService(
            {("processed", FUNCTION_APP.profile_tombstone_blob_name(target)): tombstone}
        )

        self.assertTrue(
            FUNCTION_APP.capture_is_deleted(
                service,
                "processed",
                target,
                datetime(2026, 7, 30, 11, 59, tzinfo=timezone.utc),
            )
        )
        self.assertTrue(FUNCTION_APP.capture_is_deleted(service, "processed", target, None))
        self.assertFalse(
            FUNCTION_APP.capture_is_deleted(
                service,
                "processed",
                target,
                datetime(2026, 7, 30, 12, 1, tzinfo=timezone.utc),
            )
        )
        self.assertFalse(
            FUNCTION_APP.capture_is_deleted(service, "processed", "owner", None)
        )


if __name__ == "__main__":
    unittest.main()
