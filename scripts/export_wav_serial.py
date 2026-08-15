#!/usr/bin/env python3
"""Export and validate the latest WAV from Voice Inbox over USB serial."""

from __future__ import annotations

import argparse
import base64
import binascii
import glob
import hashlib
import io
from pathlib import Path
import re
import sys
import time
import wave

import serial


START_PATTERN = re.compile(
    r"^wav_export_start path=(\S+) bytes=(\d+) encoding=base64 "
    r"sha256=([0-9a-f]{64})$"
)
DONE_PATTERN = re.compile(r"^wav_export_done bytes=(\d+) sha256=([0-9a-f]{64})$")


def resolve_port(requested: str | None) -> str:
    if requested:
        return requested
    candidates = sorted(glob.glob("/dev/cu.usbmodem*"))
    if len(candidates) != 1:
        raise RuntimeError(
            "expected exactly one /dev/cu.usbmodem* device; pass --port explicitly"
        )
    return candidates[0]


def validate_wav(data: bytes) -> dict[str, int | str]:
    with wave.open(io.BytesIO(data), "rb") as wav_file:
        metadata: dict[str, int | str] = {
            "channels": wav_file.getnchannels(),
            "sample_width": wav_file.getsampwidth(),
            "sample_rate": wav_file.getframerate(),
            "frames": wav_file.getnframes(),
            "compression": wav_file.getcomptype(),
        }
    if metadata["channels"] != 1:
        raise RuntimeError(f"unexpected channel count: {metadata['channels']}")
    if metadata["sample_width"] != 2:
        raise RuntimeError(f"unexpected sample width: {metadata['sample_width']}")
    if metadata["sample_rate"] != 16000:
        raise RuntimeError(f"unexpected sample rate: {metadata['sample_rate']}")
    if metadata["compression"] != "NONE":
        raise RuntimeError(f"unexpected compression: {metadata['compression']}")
    return metadata


def export_latest(port: str, timeout_seconds: float) -> tuple[bytes, dict[str, str | int]]:
    connection = serial.Serial()
    connection.port = port
    connection.baudrate = 115200
    connection.timeout = 0.25
    connection.write_timeout = 2
    connection.dtr = False
    connection.rts = False
    connection.open()

    try:
        time.sleep(0.5)
        connection.reset_input_buffer()
        connection.write(b"EXPORT_LATEST\n")
        connection.flush()

        deadline = time.monotonic() + timeout_seconds
        expected_path: str | None = None
        expected_bytes: int | None = None
        expected_sha256: str | None = None
        encoded_chunks: list[str] = []
        done_bytes: int | None = None
        done_sha256: str | None = None

        while time.monotonic() < deadline:
            raw_line = connection.readline()
            if not raw_line:
                continue
            line = raw_line.decode("ascii", errors="replace").strip()
            start_match = START_PATTERN.match(line)
            if start_match:
                expected_path = start_match.group(1)
                expected_bytes = int(start_match.group(2))
                expected_sha256 = start_match.group(3)
                encoded_chunks.clear()
                continue
            if line.startswith("B64:") and expected_path is not None:
                encoded_chunks.append(line[4:])
                continue
            done_match = DONE_PATTERN.match(line)
            if done_match and expected_path is not None:
                done_bytes = int(done_match.group(1))
                done_sha256 = done_match.group(2)
                break
            if line.startswith("wav_export_error"):
                raise RuntimeError(line)
        else:
            raise TimeoutError("timed out waiting for wav_export_done")
    finally:
        connection.close()

    if expected_path is None or expected_bytes is None or expected_sha256 is None:
        raise RuntimeError("device did not send wav_export_start")
    try:
        payload = base64.b64decode("".join(encoded_chunks), validate=True)
    except (ValueError, binascii.Error) as error:
        raise RuntimeError("invalid Base64 payload from device") from error

    actual_sha256 = hashlib.sha256(payload).hexdigest()
    if len(payload) != expected_bytes or done_bytes != expected_bytes:
        raise RuntimeError(
            f"length mismatch: decoded={len(payload)} start={expected_bytes} done={done_bytes}"
        )
    if actual_sha256 != expected_sha256 or done_sha256 != expected_sha256:
        raise RuntimeError(
            "SHA-256 mismatch: "
            f"decoded={actual_sha256} start={expected_sha256} done={done_sha256}"
        )

    return payload, {
        "device_path": expected_path,
        "bytes": expected_bytes,
        "sha256": expected_sha256,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", help="USB serial port; auto-detected when omitted")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=90.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.output.exists():
        print(f"refusing to overwrite existing file: {args.output}", file=sys.stderr)
        return 2

    try:
        port = resolve_port(args.port)
        payload, export_metadata = export_latest(port, args.timeout)
        wav_metadata = validate_wav(payload)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("xb") as output_file:
            output_file.write(payload)
    except (
        OSError,
        RuntimeError,
        TimeoutError,
        serial.SerialException,
        wave.Error,
    ) as error:
        print(f"export failed: {error}", file=sys.stderr)
        return 1

    duration = int(wav_metadata["frames"]) / int(wav_metadata["sample_rate"])
    print(f"saved={args.output}")
    print(f"device_path={export_metadata['device_path']}")
    print(f"bytes={export_metadata['bytes']}")
    print(f"sha256={export_metadata['sha256']}")
    print(
        "wav="
        f"{wav_metadata['sample_rate']}Hz "
        f"{int(wav_metadata['sample_width']) * 8}-bit "
        f"{wav_metadata['channels']}ch duration={duration:.3f}s"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
