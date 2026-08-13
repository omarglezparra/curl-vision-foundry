from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import cv2
import numpy as np


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    temp_parent = Path(tempfile.gettempdir()).resolve()
    with tempfile.TemporaryDirectory(prefix="ai-javier-smoke-") as temp_dir:
        test_root = Path(temp_dir).resolve()
        if test_root.parent != temp_parent:
            raise RuntimeError("Refusing to use a smoke-test directory outside the system temp folder.")

        input_video = test_root / "input.mp4"
        output_dir = test_root / "recordings"
        writer = cv2.VideoWriter(
            str(input_video),
            cv2.VideoWriter_fourcc(*"mp4v"),
            12.0,
            (320, 240),
        )
        if not writer.isOpened():
            raise RuntimeError("Could not create the synthetic smoke-test video.")
        for index in range(24):
            writer.write(np.full((240, 320, 3), (index * 3) % 255, dtype=np.uint8))
        writer.release()

        command = [
            sys.executable,
            str(repo_root / "src" / "webcam_curl_counter.py"),
            "--source",
            str(input_video),
            "--headless",
            "--record-session",
            "--no-upload-azure",
            "--video-output-dir",
            str(output_dir),
            "--session",
            "smoke_session",
            "--label",
            "unlabeled",
        ]
        subprocess.run(command, cwd=repo_root, check=True, env=os.environ.copy())

        metadata_files = list(output_dir.rglob("metadata.json"))
        if len(metadata_files) != 1:
            raise RuntimeError(f"Expected one metadata file, found {len(metadata_files)}.")
        metadata_path = metadata_files[0]
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        video_path = metadata_path.parent / metadata["video_file"]
        reps_path = metadata_path.parent / metadata["rep_data_file"]
        if not video_path.is_file() or not reps_path.is_file():
            raise RuntimeError("The capture bundle is missing video.mp4 or reps.csv.")
        print(
            "Capture smoke passed: "
            f"frames={metadata['frames_recorded']}, video={video_path.name}, reps={reps_path.name}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
