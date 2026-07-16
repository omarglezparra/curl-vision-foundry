from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path


VIDEO_EXTENSIONS = {".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"}


def default_watch_dir() -> Path:
    home = Path(os.environ.get("USERPROFILE") or Path.home())
    candidates = [
        home / "OneDrive" / "Pictures" / "\u00c1lbum de c\u00e1mara",
        home / "OneDrive" / "Pictures" / "Camera Roll",
        home / "OneDrive" / "Pictures",
        home / "Downloads",
        Path("captures") / "bv100_inbox",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[-1]


def safe_slug(value: str, fallback: str = "capture") -> str:
    slug = "".join(character if character.isalnum() or character in {"-", "_"} else "_" for character in value.strip())
    slug = "_".join(part for part in slug.split("_") if part)
    return slug or fallback


def load_state(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {"processed": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(path: Path, state: dict[str, dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), encoding="utf-8")


def video_files(directory: Path, recursive: bool) -> list[Path]:
    if not directory.exists():
        directory.mkdir(parents=True, exist_ok=True)
    pattern = "**/*" if recursive else "*"
    files = [
        path
        for path in directory.glob(pattern)
        if path.is_file() and path.suffix.lower() in VIDEO_EXTENSIONS
    ]
    return sorted(files, key=lambda path: path.stat().st_mtime)


def file_signature(path: Path) -> str:
    stat = path.stat()
    return f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"


def is_file_stable(path: Path, wait_seconds: float) -> bool:
    try:
        first = path.stat()
        time.sleep(wait_seconds)
        second = path.stat()
    except FileNotFoundError:
        return False
    return first.st_size > 0 and first.st_size == second.st_size and first.st_mtime_ns == second.st_mtime_ns


def session_id(prefix: str, video_path: Path) -> str:
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return safe_slug(f"{prefix}_{stamp}_{video_path.stem}", "bv100_auto")


def process_video(video_path: Path, args: argparse.Namespace) -> int:
    script_path = Path(__file__).with_name("webcam_curl_counter.py")
    command = [
        sys.executable,
        str(script_path),
        "--source",
        str(video_path),
        "--session",
        session_id(args.session_prefix, video_path),
        "--label",
        args.label,
        "--arm",
        args.arm,
        "--log-path",
        args.log_path,
        "--camera-angle",
        args.camera_angle,
        "--video-output-dir",
        args.video_output_dir,
        "--headless",
        "--log-good-only",
    ]
    if args.record_session:
        command.append("--record-session")
    if not args.mirror_input:
        command.append("--no-flip")

    print(f"Processing BV100 video: {video_path}")
    result = subprocess.run(command, cwd=Path(__file__).resolve().parents[1])
    return result.returncode


def mark_existing_as_seen(state: dict[str, dict], watch_dir: Path, recursive: bool) -> None:
    for path in video_files(watch_dir, recursive):
        state["processed"].setdefault(
            file_signature(path),
            {
                "path": str(path.resolve()),
                "status": "seen_before_start",
                "processed_at": datetime.now().isoformat(),
            },
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch a phone/cloud folder and auto-process BV100 curl videos.")
    parser.add_argument("--watch-dir", default=str(default_watch_dir()), help="Folder to watch for new BV100 videos.")
    parser.add_argument("--state-path", default="outputs/bv100_auto_ingest_state.json", help="JSON state file.")
    parser.add_argument("--session-prefix", default="bv100_auto", help="Prefix for generated session ids.")
    parser.add_argument("--label", default="good_form", help="Training label for imported videos.")
    parser.add_argument("--arm", choices=["auto", "left", "right"], default="auto", help="Arm to track.")
    parser.add_argument("--camera-angle", default="mirror_bv100", help="Camera angle metadata value.")
    parser.add_argument("--log-path", default="outputs/curl_reps.csv", help="CSV path for logged rep metrics.")
    parser.add_argument("--video-output-dir", default="outputs/session_videos", help="Directory for recorded copies and metadata.")
    parser.add_argument("--poll-seconds", type=float, default=4.0, help="Seconds between folder scans.")
    parser.add_argument("--stable-seconds", type=float, default=5.0, help="Seconds a file size must remain stable before processing.")
    parser.add_argument("--process-existing", action="store_true", help="Process videos already in the watch folder at startup.")
    parser.add_argument("--once", action="store_true", help="Process currently available videos, then exit.")
    parser.add_argument("--no-recursive", action="store_true", help="Only scan the top-level watch folder.")
    parser.add_argument("--no-record-session", dest="record_session", action="store_false", help="Do not save a local video copy and metadata.")
    parser.add_argument("--mirror-input", action="store_true", help="Mirror video before analysis instead of keeping raw orientation.")
    parser.set_defaults(record_session=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watch_dir = Path(args.watch_dir).expanduser()
    recursive = not args.no_recursive
    state_path = Path(args.state_path)
    state = load_state(state_path)
    state.setdefault("processed", {})

    if not args.process_existing:
        mark_existing_as_seen(state, watch_dir, recursive)
        save_state(state_path, state)

    print(f"Watching BV100 folder: {watch_dir.resolve()}")
    print("Waiting for new video files. Press Ctrl+C to stop.")

    while True:
        for path in video_files(watch_dir, recursive):
            signature = file_signature(path)
            if signature in state["processed"]:
                continue
            if not is_file_stable(path, args.stable_seconds):
                continue

            returncode = process_video(path, args)
            state["processed"][signature] = {
                "path": str(path.resolve()),
                "status": "processed" if returncode == 0 else "failed",
                "returncode": returncode,
                "processed_at": datetime.now().isoformat(),
            }
            save_state(state_path, state)

        if args.once:
            break
        time.sleep(args.poll_seconds)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
