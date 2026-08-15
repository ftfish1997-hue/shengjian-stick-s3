from __future__ import annotations

import unittest

from scripts.test_power_screen import (
    parse_power_status,
    validate_precondition,
)


GOOD_STATUS = (
    'status version=0.8.0-pomodoro-ui mic=ready fs=ready pending=0 free=1556480 '
    'next=2 provisioned=true upload_min=1 net="NET ONLINE PRIMARY"'
)
GOOD_POWER = (
    "power_status battery_pct=82 battery_mv=3975 vbus_mv=5012 "
    "charging=charging screen=on idle_ms=1200 timeout_ms=30000"
)


class PowerScreenContractTests(unittest.TestCase):
    def test_accepts_device_precondition_and_returns_pending(self) -> None:
        self.assertEqual(validate_precondition(GOOD_STATUS), 0)

    def test_rejects_wrong_firmware(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "precondition mismatch"):
            validate_precondition(
                GOOD_STATUS.replace(
                    "0.8.0-pomodoro-ui", "0.6.1-offline-test"
                )
            )

    def test_parses_power_telemetry(self) -> None:
        self.assertEqual(
            parse_power_status(GOOD_POWER),
            (82, 3975, 5012, "charging", "on", 1200, 30000),
        )


if __name__ == "__main__":
    unittest.main()
