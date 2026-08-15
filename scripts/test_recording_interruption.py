#!/usr/bin/env python3
"""Arm a one-shot capture restart and verify the pending queue is unchanged."""

from __future__ import annotations

import argparse
import glob
import re
import sys
import time

import serial


STATUS_PATTERN = re.compile(
    r"^status version=(\S+) mic=(\S+) fs=(\S+) "
    r"pending=(\d+) free=(\d+) next=(\d+)$"
)
MOUNT_PATTERN = re.compile(
    r"^filesystem_mount=true total=(\d+) used=(\d+) free=(\d+) "
    r"pending=(\d+) next=(\d+)$"
)


def resolve_port(requested: str | None) -> str:
    if requested:
        return requested
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(candidates) != 1:
        raise RuntimeError(
            "expected exactly one /dev/cu.usbmodem* device; pass --port explicitly"
        )
    return candidates[0]


def read_line(connection: serial.Serial, deadline: float) -> str | None:
    while time.monotonic() < deadline:
        raw_line = connection.readline()
        if raw_line:
            return raw_line.decode("ascii", errors="replace").strip()
    return None


def read_baseline(connection: serial.Serial, timeout_seconds: float) -> tuple[int, int]:
    connection.reset_input_buffer()
    deadline = time.monotonic() + timeout_seconds
    next_query = time.monotonic()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now >= next_query:
            connection.write(b"STATUS\n")
            connection.flush()
            next_query = now + 2.0
        line = read_line(connection, deadline)
        if line is None:
            break
        match = STATUS_PATTERN.match(line)
        if not match:
            continue
        if match.group(2) != "ready" or match.group(3) != "ready":
            raise RuntimeError(f"device is not ready: {line}")
        return int(match.group(4)), int(match.group(6))
    raise TimeoutError("timed out waiting for STATUS response")


def run_test(port: str, arm_timeout: float, reboot_timeout: float) -> None:
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = 115200
    connection.timeout = 0.1
    connection.write_timeout = 2
    connection.dtr = False
    connection.rts = False
    connection.open()

    try:
        baseline_pending, baseline_next = read_baseline(connection, 20.0)
        connection.write(b"TEST_INTERRUPT_NEXT\n")
        connection.flush()
        arm_deadline = time.monotonic() + 5.0
        while time.monotonic() < arm_deadline:
            line = read_line(connection, arm_deadline)
            if line == "test_interrupt_armed delay_ms=1000 one_shot=true":
                break
            if line and line.startswith("test_interrupt_error"):
                raise RuntimeError(line)
        else:
            raise TimeoutError("timed out waiting for test_interrupt_armed")
        print(
            f"armed baseline_pending={baseline_pending} baseline_next={baseline_next}",
            flush=True,
        )

        deadline = time.monotonic() + arm_timeout
        capture_detected = False
        while time.monotonic() < deadline:
            line = read_line(connection, deadline)
            if line is None:
                break
            if line.startswith("mic_record_start "):
                capture_detected = True
                print("capture_detected firmware_restart_in=1.0s", flush=True)
                break
        if not capture_detected:
            raise TimeoutError("timed out waiting for mic_record_start")

        stale_temporary_removed = False
        deadline = time.monotonic() + reboot_timeout
        reboot_pending: int | None = None
        reboot_next: int | None = None
        restart_triggered = False
        while time.monotonic() < deadline:
            line = read_line(connection, deadline)
            if line is None:
                break
            if line.startswith("wav_write_done"):
                raise RuntimeError("recording completed before reset took effect")
            if line.startswith("test_interrupt_trigger "):
                restart_triggered = True
                print(line, flush=True)
            if line.startswith("wav_recovery "):
                stale_temporary_removed = True
            match = MOUNT_PATTERN.match(line)
            if match:
                reboot_pending = int(match.group(4))
                reboot_next = int(match.group(5))
                break
        if reboot_pending is None or reboot_next is None:
            raise TimeoutError("timed out waiting for filesystem mount after reset")
        if not restart_triggered:
            raise RuntimeError("device rebooted without test_interrupt_trigger evidence")
        if reboot_pending != baseline_pending or reboot_next != baseline_next:
            raise RuntimeError(
                "queue changed after interrupted recording: "
                f"before pending={baseline_pending} next={baseline_next}; "
                f"after pending={reboot_pending} next={reboot_next}"
            )

        print(
            "pass "
            f"pending={reboot_pending} next={reboot_next} "
            f"stale_temporary_removed={str(stale_temporary_removed).lower()}",
            flush=True,
        )
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", help="USB serial port; auto-detected when omitted")
    parser.add_argument("--arm-timeout", type=float, default=90.0)
    parser.add_argument("--reboot-timeout", type=float, default=15.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        run_test(resolve_port(args.port), args.arm_timeout, args.reboot_timeout)
    except (OSError, RuntimeError, TimeoutError, serial.SerialException) as error:
        print(f"interruption test failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
