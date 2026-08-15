"""Deterministic host simulation for the StickS3 offline-first workflow."""

from __future__ import annotations

import json
import hashlib
import math
import os
import struct
import uuid
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


class QueueStatus(str, Enum):
    PENDING = "pending"
    UPLOADING = "uploading"
    UPLOADED = "uploaded"
    DELETE_PENDING = "delete_pending"


class PomodoroStatus(str, Enum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"


class ResponseLost(RuntimeError):
    """The server committed the event but the device did not receive the response."""


class AckValidationError(RuntimeError):
    """The response does not acknowledge the exact local event."""


class EventConflict(RuntimeError):
    """The same event ID was reused for different audio content."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temp_path, path)


def generate_test_wav(
    destination: Path,
    duration_seconds: float,
    sample_rate: int = 16_000,
    frequency_hz: float = 440.0,
) -> None:
    """Write a small deterministic PCM WAV without retaining the whole file in memory."""
    if duration_seconds <= 0 or duration_seconds > 60:
        raise ValueError("duration_seconds must be within (0, 60]")

    total_frames = max(1, round(duration_seconds * sample_rate))
    amplitude = 4_000
    with wave.open(str(destination), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        chunk_size = 1_024
        for start in range(0, total_frames, chunk_size):
            end = min(total_frames, start + chunk_size)
            frames = bytearray()
            for index in range(start, end):
                sample = int(
                    amplitude * math.sin(2.0 * math.pi * frequency_hz * index / sample_rate)
                )
                frames.extend(struct.pack("<h", sample))
            wav_file.writeframesraw(frames)


@dataclass(frozen=True)
class QueueItem:
    event_id: str
    wav_path: Path
    metadata_path: Path
    metadata: dict[str, Any]


class LocalQueue:
    def __init__(self, root: Path, device_id: str, max_bytes: int = 6 * 1024 * 1024):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.device_id = device_id
        self.max_bytes = max_bytes
        self._remove_abandoned_temp_files()

    def _remove_abandoned_temp_files(self) -> None:
        for path in self.root.glob("*.tmp"):
            path.unlink(missing_ok=True)

    def bytes_used(self) -> int:
        return sum(path.stat().st_size for path in self.root.iterdir() if path.is_file())

    def _load_metadata(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def items(self) -> list[QueueItem]:
        result: list[QueueItem] = []
        for metadata_path in sorted(self.root.glob("*.json")):
            metadata = self._load_metadata(metadata_path)
            event_id = metadata["event_id"]
            wav_path = self.root / f"{event_id}.wav"
            if wav_path.exists():
                result.append(QueueItem(event_id, wav_path, metadata_path, metadata))
        return result

    def pending_count(self) -> int:
        return len(self.items())

    def enqueue_wav(
        self,
        duration_seconds: float,
        *,
        kind: str = "voice_record",
        session_id: str | None = None,
        event_id: str | None = None,
    ) -> QueueItem:
        event_id = event_id or str(uuid.uuid4())
        wav_path = self.root / f"{event_id}.wav"
        wav_temp_path = self.root / f"{event_id}.wav.tmp"
        metadata_path = self.root / f"{event_id}.json"

        estimated_bytes = 44 + round(duration_seconds * 16_000 * 2)
        if self.bytes_used() + estimated_bytes > self.max_bytes:
            raise OSError("LOCAL_QUEUE_FULL")

        generate_test_wav(wav_temp_path, duration_seconds)
        os.replace(wav_temp_path, wav_path)
        metadata = {
            "event_id": event_id,
            "device_id": self.device_id,
            "captured_at": utc_now(),
            "kind": kind,
            "session_id": session_id,
            "duration_seconds": duration_seconds,
            "firmware_version": "simulator-0.1.0",
            "schema_version": 1,
            "queue_status": QueueStatus.PENDING.value,
            "attempts": 0,
            "record_id": None,
            "last_error": None,
        }
        atomic_json_write(metadata_path, metadata)
        return QueueItem(event_id, wav_path, metadata_path, metadata)

    def update(self, item: QueueItem, **changes: Any) -> QueueItem:
        metadata = self._load_metadata(item.metadata_path)
        metadata.update(changes)
        atomic_json_write(item.metadata_path, metadata)
        return QueueItem(item.event_id, item.wav_path, item.metadata_path, metadata)

    def delete_acknowledged(self, item: QueueItem, event_id: str, record_id: str) -> None:
        if event_id != item.event_id or not record_id:
            raise AckValidationError("server acknowledgement does not match local event")
        item = self.update(
            item,
            queue_status=QueueStatus.UPLOADED.value,
            record_id=record_id,
            last_error=None,
        )
        item = self.update(item, queue_status=QueueStatus.DELETE_PENDING.value)
        item.wav_path.unlink()
        item.metadata_path.unlink()


class FakeCloud:
    """In-memory idempotent cloud endpoint used by tests and the demo."""

    def __init__(self) -> None:
        self.records: dict[str, tuple[str, str]] = {}
        self.drop_next_response = False

    def upload(self, item: QueueItem) -> dict[str, Any]:
        duplicate = item.event_id in self.records
        audio_sha256 = hashlib.sha256(item.wav_path.read_bytes()).hexdigest()
        if duplicate:
            record_id, stored_sha256 = self.records[item.event_id]
            if stored_sha256 != audio_sha256:
                raise EventConflict("event_id already has different audio")
        else:
            record_id = str(uuid.uuid5(uuid.NAMESPACE_URL, item.event_id))
            self.records[item.event_id] = (record_id, audio_sha256)
        response = {
            "success": True,
            "event_id": item.event_id,
            "record_id": record_id,
            "status": "accepted",
            "duplicate": duplicate,
        }
        if self.drop_next_response:
            self.drop_next_response = False
            raise ResponseLost("server committed the event, response was lost")
        return response


class Pomodoro:
    def __init__(self, path: Path, recover_after_reboot: bool = False):
        self.path = path
        if path.exists():
            self.state = json.loads(path.read_text(encoding="utf-8"))
        else:
            self.state = {
                "status": PomodoroStatus.IDLE.value,
                "session_id": None,
                "planned_seconds": 0,
                "elapsed_seconds": 0,
                "interruption_reason": None,
            }
            self._save()
        if recover_after_reboot and self.state["status"] in {
            PomodoroStatus.RUNNING.value,
            PomodoroStatus.PAUSED.value,
        }:
            self.state["status"] = PomodoroStatus.INTERRUPTED.value
            self.state["interruption_reason"] = "interrupted_reboot"
            self._save()

    def _save(self) -> None:
        atomic_json_write(self.path, self.state)

    @property
    def status(self) -> PomodoroStatus:
        return PomodoroStatus(self.state["status"])

    @property
    def session_id(self) -> str | None:
        return self.state["session_id"]

    def start(self, planned_seconds: int = 1_500) -> str:
        if planned_seconds <= 0:
            raise ValueError("planned_seconds must be positive")
        if self.status in {PomodoroStatus.RUNNING, PomodoroStatus.PAUSED}:
            raise RuntimeError("pomodoro already active")
        self.state = {
            "status": PomodoroStatus.RUNNING.value,
            "session_id": str(uuid.uuid4()),
            "planned_seconds": planned_seconds,
            "elapsed_seconds": 0,
            "interruption_reason": None,
        }
        self._save()
        return self.state["session_id"]

    def tick(self, seconds: int) -> PomodoroStatus:
        if seconds < 0:
            raise ValueError("seconds cannot be negative")
        if self.status != PomodoroStatus.RUNNING:
            return self.status
        self.state["elapsed_seconds"] += seconds
        if self.state["elapsed_seconds"] >= self.state["planned_seconds"]:
            self.state["elapsed_seconds"] = self.state["planned_seconds"]
            self.state["status"] = PomodoroStatus.COMPLETED.value
        self._save()
        return self.status

    def pause(self) -> None:
        if self.status != PomodoroStatus.RUNNING:
            raise RuntimeError("pomodoro is not running")
        self.state["status"] = PomodoroStatus.PAUSED.value
        self._save()

    def resume(self) -> None:
        if self.status != PomodoroStatus.PAUSED:
            raise RuntimeError("pomodoro is not paused")
        self.state["status"] = PomodoroStatus.RUNNING.value
        self._save()


class DeviceSimulator:
    def __init__(
        self,
        data_dir: Path | str,
        *,
        device_id: str = "demo-device-001",
        cloud: FakeCloud | None = None,
        recover_after_reboot: bool = False,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.device_id = device_id
        self.queue = LocalQueue(self.data_dir / "queue", device_id)
        self.pomodoro = Pomodoro(
            self.data_dir / "pomodoro.json", recover_after_reboot=recover_after_reboot
        )
        self.cloud = cloud or FakeCloud()
        self.online = False

    def set_online(self, online: bool) -> None:
        self.online = online

    def record(self, duration_seconds: float = 1.0) -> QueueItem:
        return self.queue.enqueue_wav(duration_seconds)

    def record_pomodoro_note(self, duration_seconds: float = 1.0) -> QueueItem:
        if self.pomodoro.status not in {PomodoroStatus.RUNNING, PomodoroStatus.PAUSED}:
            raise RuntimeError("no active pomodoro session")
        return self.queue.enqueue_wav(
            duration_seconds,
            kind="pomodoro_note",
            session_id=self.pomodoro.session_id,
        )

    def sync(self) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        if not self.online:
            return results

        for item in self.queue.items():
            attempts = int(item.metadata.get("attempts", 0)) + 1
            item = self.queue.update(
                item,
                queue_status=QueueStatus.UPLOADING.value,
                attempts=attempts,
                last_error=None,
            )
            try:
                response = self.cloud.upload(item)
                self.queue.delete_acknowledged(
                    item, response.get("event_id", ""), response.get("record_id", "")
                )
                results.append(response)
            except (ResponseLost, AckValidationError, EventConflict) as exc:
                self.queue.update(
                    item,
                    queue_status=QueueStatus.PENDING.value,
                    last_error=type(exc).__name__,
                )
                results.append(
                    {
                        "success": False,
                        "event_id": item.event_id,
                        "error": type(exc).__name__,
                    }
                )
        return results

    def restart(self) -> "DeviceSimulator":
        restarted = DeviceSimulator(
            self.data_dir,
            device_id=self.device_id,
            cloud=self.cloud,
            recover_after_reboot=True,
        )
        restarted.online = self.online
        return restarted

    def status(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "network": "online" if self.online else "offline",
            "pending_records": self.queue.pending_count(),
            "queue_bytes": self.queue.bytes_used(),
            "pomodoro": dict(self.pomodoro.state),
        }
