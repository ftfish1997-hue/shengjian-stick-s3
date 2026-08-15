#!/usr/bin/env python3
"""Verify the StickS3 monotonic pomodoro timer without waiting 25 minutes."""

from __future__ import annotations

import argparse
import glob
import re
import sys
import time
from typing import Protocol


EXPECTED_VERSION = "0.8.0-pomodoro-ui"
STATUS_PATTERN = re.compile(
    r'^status version=(\S+) mic=(\S+) fs=(\S+) pending=(\d+) free=(\d+) '
    r'next=(\d+) provisioned=(true|false) upload_min=(\d+) net="([^"]+)"$'
)
POMODORO_PATTERN = re.compile(
    r"^pomodoro_status state=(idle|running|paused|completed) "
    r"remaining_ms=(\d+) planned_ms=(\d+) "
    r"view=(home|pomodoro) screen=(on|off)$"
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


def send(port: SerialPort, command: bytes) -> None:
    port.write(command)
    port.flush()


def read_line_until(port: SerialPort, predicate, timeout: float) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = port.readline().decode("ascii", errors="replace").strip()
        if line and predicate(line):
            return line
    raise TimeoutError("timed out waiting for device evidence")


def query_line(
    port: SerialPort, command: bytes, pattern: re.Pattern[str], timeout: float = 8.0
) -> str:
    deadline = time.monotonic() + timeout
    next_query = time.monotonic()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_query:
            send(port, command)
            next_query = now + 1.0
        line = port.readline().decode("ascii", errors="replace").strip()
        if pattern.match(line):
            return line
    raise TimeoutError(f"timed out waiting for {command.decode().strip()}")


def parse_status(line: str) -> tuple[str, str, str, int, str, int]:
    match = STATUS_PATTERN.match(line)
    if not match:
        raise ValueError("not a STATUS line")
    return (
        match.group(1),
        match.group(2),
        match.group(3),
        int(match.group(4)),
        match.group(7),
        int(match.group(8)),
    )


def validate_precondition(line: str) -> int:
    version, mic, filesystem, pending, provisioned, upload_minimum = parse_status(
        line
    )
    if not (
        version == EXPECTED_VERSION
        and mic == "ready"
        and filesystem == "ready"
        and provisioned == "true"
        and upload_minimum == 1
    ):
        raise RuntimeError(f"precondition mismatch: {line}")
    return pending


def parse_pomodoro(line: str) -> tuple[str, int, int, str, str]:
    match = POMODORO_PATTERN.match(line)
    if not match:
        raise ValueError("not a POMODORO_STATUS line")
    return (
        match.group(1),
        int(match.group(2)),
        int(match.group(3)),
        match.group(4),
        match.group(5),
    )


def run(port: SerialPort) -> tuple[float, int]:
    baseline_pending = validate_precondition(
        query_line(port, b"STATUS\n", STATUS_PATTERN, 45.0)
    )
    reset_sent = False
    try:
        send(port, b"TEST_POMODORO_RESET\n")
        read_line_until(
            port,
            lambda line: line
            == "pomodoro_test_reset state=idle ram_only=true",
            5.0,
        )
        reset_sent = True
        idle = parse_pomodoro(
            query_line(port, b"POMODORO_STATUS\n", POMODORO_PATTERN)
        )
        if idle[:4] != ("idle", 1500000, 1500000, "home"):
            raise RuntimeError(f"unexpected idle state: {idle}")

        started_at = time.monotonic()
        send(port, b"TEST_POMODORO_START 3\n")
        read_line_until(
            port,
            lambda line: line
            == "pomodoro_test_started duration_ms=3000 ram_only=true",
            5.0,
        )
        running = parse_pomodoro(
            query_line(port, b"POMODORO_STATUS\n", POMODORO_PATTERN)
        )
        if not (
            running[0] == "running"
            and 0 < running[1] <= 3000
            and running[2] == 3000
            and running[3] == "pomodoro"
        ):
            raise RuntimeError(f"unexpected running state: {running}")

        completion_deadline = time.monotonic() + 6.0
        completed: tuple[str, int, int, str, str] | None = None
        while time.monotonic() < completion_deadline:
            candidate = parse_pomodoro(
                query_line(
                    port,
                    b"POMODORO_STATUS\n",
                    POMODORO_PATTERN,
                    timeout=1.5,
                )
            )
            if candidate[0] == "completed":
                completed = candidate
                break
            time.sleep(0.1)
        if completed is None:
            raise TimeoutError("3-second pomodoro did not complete")
        elapsed = time.monotonic() - started_at
        if not 2.5 <= elapsed <= 5.0:
            raise RuntimeError(f"unexpected completion time: {elapsed:.3f}s")

        if completed[:4] != ("completed", 0, 3000, "pomodoro"):
            raise RuntimeError(f"unexpected completed state: {completed}")

        final_pending = validate_precondition(
            query_line(port, b"STATUS\n", STATUS_PATTERN)
        )
        if final_pending != baseline_pending:
            raise RuntimeError(
                "pomodoro test changed the recording pending queue"
            )
        return elapsed, final_pending
    finally:
        if reset_sent:
            try:
                send(port, b"TEST_POMODORO_RESET\n")
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
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
            result = run(connection)
        finally:
            connection.close()
        print("PASS elapsed_seconds={:.3f} pending={}".format(*result))
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"pomodoro-ui test failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
