#!/usr/bin/env python3
"""Verify StickS3 battery telemetry and safe screen-off/wake behavior."""

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
POWER_PATTERN = re.compile(
    r"^power_status battery_pct=(-?\d+) battery_mv=(-?\d+) vbus_mv=(-?\d+) "
    r"charging=(charging|discharging|unknown) screen=(on|off) "
    r"idle_ms=(\d+) timeout_ms=(\d+)$"
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


def validate_precondition(line: str) -> int:
    version, mic, filesystem, pending, _, provisioned, upload_minimum, _ = (
        parse_status(line)
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


def parse_power_status(
    line: str,
) -> tuple[int, int, int, str, str, int, int]:
    match = POWER_PATTERN.match(line)
    if not match:
        raise ValueError("not a POWER_STATUS line")
    return (
        int(match.group(1)),
        int(match.group(2)),
        int(match.group(3)),
        match.group(4),
        match.group(5),
        int(match.group(6)),
        int(match.group(7)),
    )


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


def query_status(port: SerialPort, timeout: float) -> str:
    deadline = time.monotonic() + timeout
    next_query = time.monotonic()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_query:
            send(port, b"STATUS\n")
            next_query = now + 2.0
        line = port.readline().decode("ascii", errors="replace").strip()
        if STATUS_PATTERN.match(line):
            return line
    raise TimeoutError("timed out waiting for STATUS")


def query_power(port: SerialPort, timeout: float = 5.0) -> str:
    send(port, b"POWER_STATUS\n")
    return read_line_until(port, lambda line: bool(POWER_PATTERN.match(line)), timeout)


def run(port: SerialPort, timeout_seconds: float) -> tuple[int, int, int, str]:
    baseline_pending = validate_precondition(query_status(port, 45.0))
    initial_power = parse_power_status(query_power(port))
    battery_pct, battery_mv, vbus_mv, charging, screen, _, screen_timeout = (
        initial_power
    )
    if not (0 <= battery_pct <= 100 and 3000 <= battery_mv <= 4500):
        raise RuntimeError(
            f"invalid battery telemetry: pct={battery_pct} mv={battery_mv}"
        )
    if screen_timeout != 30000:
        raise RuntimeError(f"unexpected screen timeout: {screen_timeout}")

    screen_forced_off = False
    try:
        if screen == "off":
            send(port, b"TEST_SCREEN_ON\n")
            read_line_until(port, lambda line: line.startswith("screen_on reason=test"), 5.0)

        send(port, b"TEST_SCREEN_OFF\n")
        read_line_until(port, lambda line: line.startswith("screen_off reason=test"), 5.0)
        if parse_power_status(query_power(port))[4] != "off":
            raise RuntimeError("screen did not report off after test command")
        screen_forced_off = True

        print("READY: press A once to wake the screen", flush=True)
        read_line_until(
            port, lambda line: line.startswith("screen_on reason=button"), timeout_seconds
        )
        screen_forced_off = False

        observation_deadline = time.monotonic() + 2.0
        status_after_wake: str | None = None
        next_query = time.monotonic()
        while time.monotonic() < observation_deadline:
            now = time.monotonic()
            if now >= next_query:
                send(port, b"STATUS\n")
                next_query = now + 0.75
            line = port.readline().decode("ascii", errors="replace").strip()
            if line.startswith("mic_record_start"):
                raise RuntimeError("wake press incorrectly started a recording")
            if STATUS_PATTERN.match(line):
                status_after_wake = line
        if status_after_wake is None:
            raise RuntimeError("STATUS missing after wake")
        if validate_precondition(status_after_wake) != baseline_pending:
            raise RuntimeError("wake press changed the pending queue")

        read_line_until(
            port, lambda line: line.startswith("screen_off reason=idle"), 40.0
        )
        screen_forced_off = True
        if parse_power_status(query_power(port))[4] != "off":
            raise RuntimeError("screen did not report off after idle timeout")

        send(port, b"TEST_SCREEN_ON\n")
        read_line_until(port, lambda line: line.startswith("screen_on reason=test"), 5.0)
        screen_forced_off = False
        if parse_power_status(query_power(port))[4] != "on":
            raise RuntimeError("screen did not report on after cleanup")
        return battery_pct, battery_mv, vbus_mv, charging
    finally:
        if screen_forced_off:
            try:
                send(port, b"TEST_SCREEN_ON\n")
            except OSError:
                pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--wake-timeout", type=float, default=90.0)
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
            result = run(connection, args.wake_timeout)
        finally:
            connection.close()
        print(
            "PASS battery_pct={} battery_mv={} vbus_mv={} charging={}".format(
                *result
            )
        )
    except (OSError, RuntimeError, TimeoutError, ValueError) as error:
        print(f"power-screen test failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
