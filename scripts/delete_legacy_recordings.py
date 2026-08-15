#!/usr/bin/env python3
"""Delete only the guarded StickS3 legacy WAV set and verify migration state."""

from __future__ import annotations

import argparse
import glob
import re
import sys
import time

import serial


STATUS_PATTERN = re.compile(
    r'^status version=(\S+) mic=(\S+) fs=(\S+) pending=(\d+) free=(\d+) '
    r'next=(\d+) provisioned=(true|false) upload_min=(\d+) net="([^"]+)"$'
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


def run(port: str, timeout_seconds: float) -> str:
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = 115200
    connection.timeout = 0.25
    connection.write_timeout = 2
    connection.dtr = False
    connection.rts = False
    connection.open()
    try:
        deadline = time.monotonic() + timeout_seconds
        next_status_query = time.monotonic() + 1.5
        delete_sent = False
        delete_done = False
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_status_query:
                connection.write(b"STATUS\n")
                connection.flush()
                next_status_query = now + 2.0

            raw_line = connection.readline()
            if not raw_line:
                continue
            line = raw_line.decode("ascii", errors="replace").strip()
            if line.startswith(("legacy_delete_refused", "legacy_delete_incomplete")):
                raise RuntimeError(line)
            if line.startswith("legacy_delete_done "):
                delete_done = True
                connection.write(b"STATUS\n")
                connection.flush()
                next_status_query = now + 1.0
                continue

            match = STATUS_PATTERN.match(line)
            if not match:
                continue
            version, mic, filesystem = match.group(1), match.group(2), match.group(3)
            pending, next_sequence = int(match.group(4)), int(match.group(6))
            provisioned, upload_minimum = match.group(7), int(match.group(8))
            if not delete_sent:
                expected = (
                    version == "0.5.0-manual"
                    and mic == "ready"
                    and filesystem == "ready"
                    and pending == 6
                    and next_sequence == 7
                    and provisioned == "true"
                    and upload_minimum == 7
                )
                if not expected:
                    raise RuntimeError(f"precondition mismatch: {line}")
                connection.write(b"DELETE_LEGACY_1_6 CONFIRM\n")
                connection.flush()
                delete_sent = True
                continue
            if (
                delete_done
                and pending == 0
                and next_sequence == 1
                and provisioned == "true"
                and upload_minimum == 1
            ):
                return line
        raise TimeoutError("timed out before verified legacy deletion completed")
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--timeout", type=float, default=25.0)
    args = parser.parse_args()
    try:
        print(run(resolve_port(args.port), args.timeout))
    except (OSError, RuntimeError, TimeoutError, serial.SerialException) as error:
        print(f"legacy deletion failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
