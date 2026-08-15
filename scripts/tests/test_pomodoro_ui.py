import unittest

from scripts.test_pomodoro_ui import (
    parse_pomodoro,
    parse_status,
    validate_precondition,
)


GOOD_STATUS = (
    'status version=0.8.0-pomodoro-ui mic=ready fs=ready pending=0 '
    'free=1556480 next=1 provisioned=true upload_min=1 '
    'net="NET ONLINE PRIMARY"'
)


class PomodoroUiScriptTests(unittest.TestCase):
    def test_status_precondition(self):
        self.assertEqual(validate_precondition(GOOD_STATUS), 0)
        self.assertEqual(parse_status(GOOD_STATUS)[0], "0.8.0-pomodoro-ui")

    def test_status_rejects_old_firmware(self):
        with self.assertRaises(RuntimeError):
            validate_precondition(
                GOOD_STATUS.replace("0.8.0-pomodoro-ui", "0.7.0-power")
            )

    def test_parse_pomodoro_status(self):
        self.assertEqual(
            parse_pomodoro(
                "pomodoro_status state=running remaining_ms=1499000 "
                "planned_ms=1500000 view=pomodoro screen=on"
            ),
            ("running", 1499000, 1500000, "pomodoro", "on"),
        )

    def test_parse_pomodoro_rejects_unknown_state(self):
        with self.assertRaises(ValueError):
            parse_pomodoro(
                "pomodoro_status state=broken remaining_ms=0 "
                "planned_ms=1500000 view=home screen=off"
            )


if __name__ == "__main__":
    unittest.main()
