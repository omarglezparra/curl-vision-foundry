from __future__ import annotations

import queue
import threading
from datetime import datetime
from pathlib import Path


class VoiceCoach:
    def __init__(self, enabled: bool, rate: int = 175) -> None:
        self.enabled = enabled
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._rate = rate

        if self.enabled:
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def say(self, message: str) -> None:
        if self.enabled:
            self._queue.put(message)

    def close(self) -> None:
        if self.enabled:
            self._queue.put(None)
            if self._thread:
                self._thread.join(timeout=2)

    def _log(self, message: str) -> None:
        path = Path("outputs/voice_coach.log")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as file:
            file.write(f"{datetime.now().isoformat()} {message}\n")

    def _run(self) -> None:
        try:
            engine = self._create_engine()
            self._log("voice engine started")
        except Exception as exc:
            self._log(f"voice engine failed: {exc!r}")
            return

        while True:
            message = self._queue.get()
            if message is None:
                break
            try:
                self._speak(engine, message)
                self._log(f"spoken: {message}")
            except Exception as exc:
                self._log(f"speak failed: {exc!r}; message={message}")

    def _create_engine(self):
        try:
            import pythoncom
            import win32com.client

            pythoncom.CoInitialize()
            voice = win32com.client.Dispatch("SAPI.SpVoice")
            voice.Rate = 0
            return ("sapi", voice)
        except Exception as exc:
            self._log(f"sapi unavailable, trying pyttsx3: {exc!r}")

        import pyttsx3

        engine = pyttsx3.init()
        engine.setProperty("rate", self._rate)
        return ("pyttsx3", engine)

    def _speak(self, engine, message: str) -> None:
        kind, instance = engine
        if kind == "sapi":
            instance.Speak(message)
            return

        instance.say(message)
        instance.runAndWait()
