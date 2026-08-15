from __future__ import annotations

import base64
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.configure_wifi import (
    build_wifi_command,
    read_macos_dialog,
    read_value,
    validate_result,
    validate_status,
)


class ConfigureWifiTests(unittest.TestCase):
    def test_builds_redaction_safe_base64_command(self) -> None:
        command = build_wifi_command(2, "手机热点".encode(), b"abcdefgh")
        parts = command.decode("ascii").strip().split(" ")
        self.assertEqual(parts[:2], ["WIFI_SET_V1", "2"])
        self.assertEqual(base64.b64decode(parts[2]), "手机热点".encode())
        self.assertEqual(base64.b64decode(parts[3]), b"abcdefgh")
        self.assertNotIn("手机热点".encode(), command)
        self.assertNotIn(b"abcdefgh", command)

    def test_rejects_invalid_slot_and_lengths(self) -> None:
        with self.assertRaisesRegex(ValueError, "slot"):
            build_wifi_command(3, b"ssid", b"abcdefgh")
        with self.assertRaisesRegex(ValueError, "SSID"):
            build_wifi_command(0, b"", b"abcdefgh")
        with self.assertRaisesRegex(ValueError, "password"):
            build_wifi_command(0, b"ssid", b"short")

    def test_reads_one_line_without_trailing_newline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "value"
            path.write_bytes(b"one-line\r\n")
            self.assertEqual(read_value(path, "test"), b"one-line")
            path.write_bytes(b"line-one\nline-two")
            with self.assertRaisesRegex(ValueError, "one line"):
                read_value(path, "test")

    @patch("scripts.configure_wifi.subprocess.run")
    def test_reads_hidden_macos_dialog_without_printing_value(self, run) -> None:
        run.return_value.stdout = "secret-value\n"
        self.assertEqual(
            read_macos_dialog("请输入手机热点密码", hidden=True),
            b"secret-value",
        )
        script = run.call_args.args[0][2]
        self.assertIn("with hidden answer", script)
        self.assertTrue(run.call_args.kwargs["capture_output"])

    def test_validates_candidate_firmware_status(self) -> None:
        validate_status(
            b'status version=0.6.0-multiwifi mic=ready fs=ready '
            b'pending=0 free=100 next=2 provisioned=true upload_min=1 '
            b'net="NET ONLINE PRIMARY"\n'
        )
        validate_status(
            b'status version=0.6.1-offline-test mic=ready fs=ready '
            b'pending=0 free=100 next=2 provisioned=true upload_min=1 '
            b'net="NET ONLINE PRIMARY"\n'
        )
        validate_status(
            b'status version=0.7.0-power mic=ready fs=ready '
            b'pending=0 free=100 next=2 provisioned=true upload_min=1 '
            b'net="NET ONLINE PRIMARY"\n'
        )
        validate_status(
            b'status version=0.8.0-pomodoro-ui mic=ready fs=ready '
            b'pending=0 free=100 next=2 provisioned=true upload_min=1 '
            b'net="NET ONLINE PRIMARY"\n'
        )
        with self.assertRaisesRegex(RuntimeError, "expected"):
            validate_status(
                b"status version=0.5.3-idempotency provisioned=true\n"
            )

    def test_validates_exact_slot_confirmation(self) -> None:
        validate_result(
            b"wifi_config_ok slot=2 role=HOTSPOT configured=true "
            b"restart_required=true\n",
            2,
        )
        with self.assertRaisesRegex(RuntimeError, "requested"):
            validate_result(
                b"wifi_config_ok slot=1 role=FALLBACK configured=true "
                b"restart_required=true\n",
                2,
            )


if __name__ == "__main__":
    unittest.main()
