#!/usr/bin/env python3
"""Run the one-shot StickS3 lost-upload-ack idempotency test."""

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
EVENT_PATTERN = re.compile(
    r"event_id=([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12})"
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
        armed = False
        event_id: str | None = None
        first_ack_seen = False
        dropped_ack_seen = False
        preserved_status_seen = False
        duplicate_ack_seen = False
        upload_done_seen = False

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

            status = STATUS_PATTERN.match(line)
            if status:
                version, mic, filesystem = status.group(1), status.group(2), status.group(3)
                pending = int(status.group(4))
                provisioned = status.group(7)
                upload_minimum = int(status.group(8))
                if not armed:
                    if not (
                        version == "0.5.3-idempotency"
                        and mic == "ready"
                        and filesystem == "ready"
                        and pending == 0
                        and provisioned == "true"
                        and upload_minimum == 1
                    ):
                        raise RuntimeError(f"precondition mismatch: {line}")
                    connection.write(b"TEST_DROP_ACK_NEXT\n")
                    connection.flush()
                    continue
                if dropped_ack_seen and not duplicate_ack_seen and pending == 1:
                    preserved_status_seen = True
                if upload_done_seen and pending == 0:
                    if not preserved_status_seen:
                        raise RuntimeError("retry completed before pending=1 preservation was observed")
                    return event_id or ""
                continue

            if line == "test_drop_ack_armed one_shot=true restart_clears=true":
                if not armed:
                    armed = True
                    print("READY: press A, record a short phrase, then press A to stop", flush=True)
                continue
            if line.startswith("test_drop_ack_error"):
                raise RuntimeError(line)

            event_match = EVENT_PATTERN.search(line)
            line_event = event_match.group(1) if event_match else None
            if line.startswith("metadata_saved ") and line_event:
                event_id = line_event
                print(f"EVENT_ID={event_id}", flush=True)
            elif line.startswith("upload_ack ") and line_event:
                if event_id is None or line_event != event_id:
                    raise RuntimeError(f"unexpected event id: {line}")
                if "duplicate=false" in line:
                    first_ack_seen = True
                elif "duplicate=true" in line:
                    duplicate_ack_seen = True
                else:
                    raise RuntimeError(f"duplicate flag missing: {line}")
            elif line.startswith("test_drop_ack_triggered ") and line_event:
                if not first_ack_seen or line_event != event_id or "local_preserved=true" not in line:
                    raise RuntimeError(f"invalid dropped-ack event: {line}")
                dropped_ack_seen = True
                connection.write(b"STATUS\n")
                connection.flush()
                next_status_query = now + 1.0
                print("FIRST_ACK_DROPPED_LOCAL_PRESERVED", flush=True)
            elif line.startswith("upload_done ") and line_event:
                if (
                    not duplicate_ack_seen
                    or line_event != event_id
                    or "duplicate=true" not in line
                    or "local_deleted=true" not in line
                ):
                    raise RuntimeError(f"invalid retry completion: {line}")
                upload_done_seen = True
                connection.write(b"STATUS\n")
                connection.flush()
                next_status_query = now + 1.0
                print("DUPLICATE_ACK_LOCAL_DELETED", flush=True)

        raise TimeoutError("timed out before the lost-ack retry completed")
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    try:
        event_id = run(resolve_port(args.port), args.timeout)
        print(f"PASS event_id={event_id}")
    except (OSError, RuntimeError, TimeoutError, serial.SerialException) as error:
        print(f"lost-ack test failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
