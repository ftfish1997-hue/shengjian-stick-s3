#!/usr/bin/env python3
"""Read Voice Inbox status without changing device state."""

from __future__ import annotations

import argparse
import glob
import re
import sys
import time

import serial


STATUS_PATTERN = re.compile(
    r"^status version=(\S+) mic=(\S+) fs=(\S+) "
    r"pending=(\d+) free=(\d+) next=(\d+) "
    r"provisioned=(true|false) upload_min=(\d+) net=\"([^\"]+)\"$"
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


def read_status(port: str, timeout_seconds: float) -> str:
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
        next_query = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_query:
                connection.write(b"STATUS\n")
                connection.flush()
                next_query = now + 2.0
            raw_line = connection.readline()
            if not raw_line:
                continue
            line = raw_line.decode("ascii", errors="replace").strip()
            if STATUS_PATTERN.match(line):
                return line
        raise TimeoutError("timed out waiting for STATUS response")
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--timeout", type=float, default=15.0)
    args = parser.parse_args()
    try:
        print(read_status(resolve_port(args.port), args.timeout))
    except (OSError, RuntimeError, TimeoutError, serial.SerialException) as error:
        print(f"status failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
