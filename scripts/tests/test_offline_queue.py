from __future__ import annotations

import unittest

from scripts.test_offline_queue import (
    parse_status,
    validate_precondition,
    validate_safe_state,
)


GOOD_STATUS = (
    'status version=0.8.0-pomodoro-ui mic=ready fs=ready pending=0 '
    'free=1556480 next=1 provisioned=true upload_min=1 '
    'net="NET ONLINE PRIMARY"'
)


class OfflineQueueContractTests(unittest.TestCase):
    def test_parses_expected_status(self) -> None:
        self.assertEqual(
            parse_status(GOOD_STATUS),
            (
                "0.8.0-pomodoro-ui",
                "ready",
                "ready",
                0,
                1,
                "true",
                1,
                "NET ONLINE PRIMARY",
            ),
        )

    def test_accepts_safe_online_empty_queue_precondition(self) -> None:
        validate_precondition(GOOD_STATUS)

    def test_rejects_existing_pending_recording(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "precondition mismatch"):
            validate_precondition(GOOD_STATUS.replace("pending=0", "pending=1"))

    def test_rejects_offline_precondition(self) -> None:
        offline = GOOD_STATUS.replace(
            'net="NET ONLINE PRIMARY"', 'net="NET TRY HOTSPOT"'
        )
        self.assertEqual(validate_safe_state(offline), "NET TRY HOTSPOT")
        with self.assertRaisesRegex(RuntimeError, "precondition mismatch"):
            validate_precondition(offline)


if __name__ == "__main__":
    unittest.main()
