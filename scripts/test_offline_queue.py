#!/usr/bin/env python3
"""Verify one offline StickS3 recording is queued, then uploaded on resume."""

from __future__ import annotations

import argparse
import glob
import re
import sys
import time
from typing import Protocol


SUPPORTED_VERSIONS = {
    "0.6.1-offline-test",
    "0.7.0-power",
    "0.8.0-pomodoro-ui",
}
STATUS_PATTERN = re.compile(
    r'^status version=(\S+) mic=(\S+) fs=(\S+) pending=(\d+) free=(\d+) '
    r'next=(\d+) provisioned=(true|false) upload_min=(\d+) net="([^"]+)"$'
)
EVENT_PATTERN = re.compile(
    r"event_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12})"
)


class SerialPort(Protocol):
    def readline(self) -> bytes: ...

    def write(self, data: bytes) -> int: ...

    def flush(self) -> None: ...


def resolve_port(requested: str | None) -> str:
    if requested:
        return requested
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(candidates) != 1:
        raise RuntimeError(
            "expected exactly one /dev/cu.usbmodem* device; pass --port explicitly"
        )
    return candidates[0]


def parse_status(line: str) -> tuple[str, str, str, int, int, str, int, str]:
    match = STATUS_PATTERN.match(line)
    if not match:
        raise ValueError("not a STATUS line")
    return (
        match.group(1),
        match.group(2),
        match.group(3),
        int(match.group(4)),
        int(match.group(6)),
        match.group(7),
        int(match.group(8)),
        match.group(9),
    )


def validate_safe_state(line: str) -> str:
    version, mic, filesystem, pending, _, provisioned, upload_minimum, net = (
        parse_status(line)
    )
    if not (
        version in SUPPORTED_VERSIONS
        and mic == "ready"
        and filesystem == "ready"
        and pending == 0
        and provisioned == "true"
        and upload_minimum == 1
    ):
        raise RuntimeError(f"precondition mismatch: {line}")
    return net


def validate_precondition(line: str) -> None:
    if not validate_safe_state(line).startswith("NET ONLINE"):
        raise RuntimeError(f"precondition mismatch: {line}")


def send(port: SerialPort, command: bytes) -> None:
    port.write(command)
    port.flush()


def run(port: SerialPort, timeout_seconds: float) -> str:
    deadline = time.monotonic() + timeout_seconds
    next_status_query = time.monotonic() + 8.0
    pause_requested = False
    paused = False
    offline_saved = False
    resume_requested = False
    resumed = False
    upload_done = False
    event_id: str | None = None

    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_status_query:
                send(port, b"STATUS\n")
                next_status_query = now + 2.0

            raw_line = port.readline()
            if not raw_line:
                continue
            line = raw_line.decode("ascii", errors="replace").strip()

            status = STATUS_PATTERN.match(line)
            if status:
                values = parse_status(line)
                pending, net = values[3], values[7]
                if not pause_requested:
                    if not validate_safe_state(line).startswith("NET ONLINE"):
                        continue
                    send(port, b"TEST_NETWORK_PAUSE\n")
                    pause_requested = True
                    continue
                if paused and not offline_saved and pending == 1:
                    if net != "NET TEST PAUSED":
                        raise RuntimeError(
                            "recording queued without paused-network evidence"
                        )
                    offline_saved = True
                    print("OFFLINE_SAVED pending=1", flush=True)
                    send(port, b"TEST_NETWORK_RESUME\n")
                    resume_requested = True
                    continue
                if resumed and upload_done and pending == 0:
                    return event_id or ""
                continue

            if line == "test_network_paused ram_only=true restart_clears=true":
                paused = True
                print(
                    "READY: press A, record one short phrase, then press A to stop",
                    flush=True,
                )
            elif line.startswith("test_network_pause_error"):
                raise RuntimeError(line)
            elif line == "test_network_resumed reconnect=automatic":
                resumed = True
                print("NETWORK_RESUMED", flush=True)
            elif line.startswith("test_network_resume_error"):
                raise RuntimeError(line)

            event_match = EVENT_PATTERN.search(line)
            line_event = event_match.group(1) if event_match else None
            if line.startswith("metadata_saved ") and line_event:
                event_id = line_event
            elif line.startswith("upload_done ") and line_event:
                if not resume_requested or line_event != event_id:
                    raise RuntimeError(f"unexpected upload completion: {line}")
                if "local_deleted=true" not in line:
                    raise RuntimeError(f"local deletion confirmation missing: {line}")
                upload_done = True
                send(port, b"STATUS\n")
                next_status_query = now + 1.0
                print("UPLOAD_ACK_LOCAL_DELETED", flush=True)

        raise TimeoutError("timed out before offline queue recovery completed")
    finally:
        if pause_requested and not resume_requested:
            try:
                send(port, b"TEST_NETWORK_RESUME\n")
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()

    try:
        import serial

        connection = serial.Serial()
        connection.port = resolve_port(args.port)
        connection.baudrate = 115200
        connection.timeout = 0.25
        connection.write_timeout = 2
        connection.dtr = False
        connection.rts = False
        connection.open()
        try:
            event_id = run(connection, args.timeout)
        finally:
            connection.close()
        print(f"PASS event_id={event_id}")
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"offline-queue test failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
