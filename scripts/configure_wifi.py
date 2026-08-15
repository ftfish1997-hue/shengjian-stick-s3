#!/usr/bin/env python3
"""Configure one StickS3 Wi-Fi slot without printing credentials."""

from __future__ import annotations

import argparse
import base64
from pathlib import Path
import re
import subprocess
import time
from typing import Protocol


SUPPORTED_FIRMWARE_VERSIONS = {
    "0.6.0-multiwifi",
    "0.6.1-offline-test",
    "0.7.0-power",
    "0.8.0-pomodoro-ui",
}
SLOT_ROLES = ("PRIMARY", "FALLBACK", "HOTSPOT")
STATUS_PATTERN = re.compile(
    rb"status version=(?P<version>\S+).* provisioned=(?P<provisioned>true|false)"
)


class SerialPort(Protocol):
    def readline(self) -> bytes: ...

    def write(self, data: bytes) -> int: ...


def encoded(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def read_value(path: Path, label: str) -> bytes:
    value = path.read_bytes()
    if value.endswith(b"\r\n"):
        value = value[:-2]
    elif value.endswith(b"\n"):
        value = value[:-1]
    if not value:
        raise ValueError(f"{label} file is empty: {path}")
    if b"\r" in value or b"\n" in value:
        raise ValueError(f"{label} must be exactly one line")
    return value


def build_wifi_command(slot: int, ssid: bytes, password: bytes) -> bytes:
    if slot not in range(len(SLOT_ROLES)):
        raise ValueError("Wi-Fi slot must be 0, 1, or 2")
    if not 1 <= len(ssid) <= 32:
        raise ValueError("Wi-Fi SSID length must be 1..32 bytes")
    if not 8 <= len(password) <= 63:
        raise ValueError("Wi-Fi password length must be 8..63 bytes")
    return (
        f"WIFI_SET_V1 {slot} {encoded(ssid)} {encoded(password)}\n"
    ).encode("ascii")


def read_macos_dialog(prompt: str, hidden: bool) -> bytes:
    hidden_clause = " with hidden answer" if hidden else ""
    script = (
        f'text returned of (display dialog "{prompt}" '
        f'default answer ""{hidden_clause} buttons {{"取消", "确定"}} '
        'default button "确定" cancel button "取消")'
    )
    result = subprocess.run(
        ["osascript", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.rstrip("\r\n").encode("utf-8")
    if not value:
        raise ValueError(f"{prompt} cannot be empty")
    return value


def read_until(port: SerialPort, marker: bytes, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    collected = bytearray()
    while time.monotonic() < deadline:
        chunk = port.readline()
        if chunk:
            collected.extend(chunk)
            if marker in chunk:
                return bytes(collected)
    raise TimeoutError(f"device did not emit {marker.decode('ascii')} in time")


def validate_status(response: bytes) -> None:
    match = STATUS_PATTERN.search(response)
    if not match:
        raise RuntimeError("device did not return a valid STATUS line")
    version = match.group("version").decode("ascii")
    if version not in SUPPORTED_FIRMWARE_VERSIONS:
        raise RuntimeError(
            f"device firmware is {version}; expected a supported multi-Wi-Fi version"
        )
    if match.group("provisioned") != b"true":
        raise RuntimeError("device identity is not provisioned")


def validate_result(response: bytes, slot: int) -> None:
    expected = (
        f"wifi_config_ok slot={slot} role={SLOT_ROLES[slot]} "
        "configured=true restart_required=true"
    ).encode("ascii")
    if expected not in response:
        raise RuntimeError("device did not confirm the requested Wi-Fi slot")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--slot", type=int, choices=range(3), required=True)
    parser.add_argument("--ssid-file", type=Path)
    parser.add_argument("--wifi-password-file", type=Path)
    parser.add_argument("--macos-dialog", action="store_true")
    args = parser.parse_args()

    if args.macos_dialog:
        if args.ssid_file or args.wifi_password_file:
            parser.error("--macos-dialog cannot be combined with credential files")
        ssid = read_macos_dialog("请输入手机热点名称", hidden=False)
        password = read_macos_dialog("请输入手机热点密码", hidden=True)
    else:
        if not args.ssid_file or not args.wifi_password_file:
            parser.error(
                "provide both credential files, or use --macos-dialog"
            )
        ssid = read_value(args.ssid_file, "SSID")
        password = read_value(args.wifi_password_file, "Wi-Fi password")
    command = build_wifi_command(args.slot, ssid, password)
    ssid = b""
    password = b""

    try:
        import serial
    except ImportError as error:
        raise RuntimeError(
            "pyserial is required; use the existing project virtual environment"
        ) from error

    with serial.Serial(args.port, 115200, timeout=0.25) as port:
        time.sleep(1.0)
        port.reset_input_buffer()
        port.write(b"STATUS\n")
        validate_status(read_until(port, b"status version=", 5.0))
        port.write(command)
        response = read_until(port, b"wifi_config_ok", 8.0)
        validate_result(response, args.slot)

    print(
        f"{SLOT_ROLES[args.slot]} Wi-Fi slot accepted; "
        "SSID and password were not printed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
