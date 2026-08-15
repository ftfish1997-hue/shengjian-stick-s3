#!/usr/bin/env python3
"""Provision StickS3 Wi-Fi and device credentials without printing secrets."""

from __future__ import annotations

import argparse
import base64
from pathlib import Path
import re
import time

import serial


STATUS_PATTERN = re.compile(r"status .* pending=(\d+) .* next=(\d+)")


def encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def read_secret(path: Path) -> bytes:
    value = path.read_bytes()
    if value.endswith(b"\n"):
        value = value[:-1]
    if not value:
        raise ValueError(f"secret file is empty: {path}")
    return value


def read_until(port: serial.Serial, marker: bytes, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    collected = bytearray()
    while time.monotonic() < deadline:
        chunk = port.readline()
        if chunk:
            collected.extend(chunk)
            if marker in chunk:
                return bytes(collected)
    raise TimeoutError(f"device did not emit {marker.decode('ascii')} in time")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--ssid", required=True)
    parser.add_argument("--wifi-password-file", type=Path, required=True)
    parser.add_argument("--device-id", default="demo-device-001")
    parser.add_argument("--device-token-file", type=Path, required=True)
    parser.add_argument("--minimum-sequence", type=int, default=7)
    args = parser.parse_args()

    password = read_secret(args.wifi_password_file)
    token = read_secret(args.device_token_file)
    if not 8 <= len(password) <= 63:
        raise ValueError("Wi-Fi password length must be 8..63 bytes")
    if len(token) < 32:
        raise ValueError("device token is too short")

    command = " ".join(
        (
            "PROVISION_V1",
            encoded(args.ssid.encode("utf-8")),
            encoded(password),
            encoded(args.device_id.encode("utf-8")),
            encoded(token),
            str(args.minimum_sequence),
        )
    )
    password = b""
    token = b""

    with serial.Serial(args.port, 115200, timeout=0.25) as port:
        time.sleep(1.0)
        port.reset_input_buffer()
        port.write((command + "\n").encode("ascii"))
        response = read_until(port, b"provision_ok", 8.0)
        if b"upload_min=7" not in response:
            raise RuntimeError("device did not preserve the six-record migration floor")
    print("provisioning accepted; credentials were not printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
