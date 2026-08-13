from __future__ import annotations

from contextlib import contextmanager
import importlib.util
import os
import sys
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROCESSOR_DIR = ROOT / "azure" / "processor"
SOURCE_DIR = ROOT / "src"
sys.path.insert(0, str(SOURCE_DIR))

spec = importlib.util.spec_from_file_location(
    "run_scheduled_processor",
    PROCESSOR_DIR / "run_scheduled_processor.py",
)
assert spec and spec.loader
RUNNER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(RUNNER)


class ProcessorRunnerTests(unittest.TestCase):
    def test_processor_command_forwards_arguments_without_a_shell(self) -> None:
        command = RUNNER.processor_command(["--limit", "1", "--frame-stride", "3"])

        self.assertEqual(command[0], sys.executable)
        self.assertEqual(Path(command[1]).name, "process_azure_captures.py")
        self.assertEqual(command[2:], ["--limit", "1", "--frame-stride", "3"])

    def test_lock_settings_fit_blob_lease_constraints(self) -> None:
        self.assertEqual(RUNNER.PROCESSOR_RUN_LOCK_SECONDS, 60)
        self.assertGreater(RUNNER.PROCESSOR_RUN_RENEW_SECONDS, 0)
        self.assertLess(
            RUNNER.PROCESSOR_RUN_RENEW_SECONDS,
            RUNNER.PROCESSOR_RUN_LOCK_SECONDS,
        )

    def test_run_waits_for_child_without_leaking_lease_event(self) -> None:
        @contextmanager
        def fake_lease(_service, _processed_container):
            yield (object(), [])

        class FakeProcess:
            returncode = 0

            def __init__(self) -> None:
                self.polls = 0

            def poll(self):
                self.polls += 1
                return None if self.polls == 1 else 0

        environment = {
            "AZURE_STORAGE_ACCOUNT_NAME": "storageaccount",
            "AZURE_STORAGE_CONNECTION_STRING": "",
        }
        with (
            patch.dict(os.environ, environment),
            patch.object(RUNNER, "load_dotenv", return_value=None),
            patch.object(RUNNER, "create_blob_service", return_value=object()),
            patch.object(RUNNER, "processor_run_lease", fake_lease),
            patch.object(RUNNER.subprocess, "Popen", return_value=FakeProcess()),
            patch.object(RUNNER.time, "sleep", return_value=None),
        ):
            self.assertEqual(RUNNER.run(["--incremental"]), 0)


if __name__ == "__main__":
    unittest.main()
