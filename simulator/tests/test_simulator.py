from __future__ import annotations

import tempfile
import unittest
import wave
from pathlib import Path

from simulator.core import DeviceSimulator, FakeCloud, PomodoroStatus


class WrongAckCloud(FakeCloud):
    def upload(self, item):
        response = super().upload(item)
        response["event_id"] = "00000000-0000-0000-0000-000000000000"
        return response


class SimulatorTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_wav_format_is_16khz_16bit_mono(self):
        device = DeviceSimulator(self.data_dir)
        item = device.record(0.1)
        with wave.open(str(item.wav_path), "rb") as wav_file:
            self.assertEqual(wav_file.getframerate(), 16_000)
            self.assertEqual(wav_file.getsampwidth(), 2)
            self.assertEqual(wav_file.getnchannels(), 1)
            self.assertGreater(wav_file.getnframes(), 0)

    def test_offline_queue_survives_restart(self):
        device = DeviceSimulator(self.data_dir)
        device.set_online(False)
        event_id = device.record(0.05).event_id
        restarted = device.restart()
        self.assertEqual(restarted.queue.pending_count(), 1)
        self.assertEqual(restarted.queue.items()[0].event_id, event_id)

    def test_lost_response_retries_idempotently(self):
        cloud = FakeCloud()
        device = DeviceSimulator(self.data_dir, cloud=cloud)
        device.set_online(True)
        event_id = device.record(0.05).event_id
        cloud.drop_next_response = True

        first_results = device.sync()
        self.assertEqual(first_results[0]["error"], "ResponseLost")
        self.assertEqual(device.queue.pending_count(), 1)
        self.assertEqual(len(cloud.records), 1)

        second_results = device.sync()
        self.assertTrue(second_results[0]["duplicate"])
        self.assertEqual(second_results[0]["event_id"], event_id)
        self.assertEqual(device.queue.pending_count(), 0)
        self.assertEqual(len(cloud.records), 1)

    def test_wrong_ack_does_not_delete_local_record(self):
        device = DeviceSimulator(self.data_dir, cloud=WrongAckCloud())
        device.set_online(True)
        device.record(0.05)
        results = device.sync()
        self.assertEqual(results[0]["error"], "AckValidationError")
        self.assertEqual(device.queue.pending_count(), 1)

    def test_same_event_with_different_audio_is_conflict(self):
        cloud = FakeCloud()
        device = DeviceSimulator(self.data_dir, cloud=cloud)
        device.set_online(True)
        event_id = "7f318967-ea46-4c02-ae1a-1d62f899d659"
        device.queue.enqueue_wav(0.05, event_id=event_id)
        self.assertTrue(device.sync()[0]["success"])

        device.queue.enqueue_wav(0.06, event_id=event_id)
        result = device.sync()[0]
        self.assertEqual(result["error"], "EventConflict")
        self.assertEqual(device.queue.pending_count(), 1)
        self.assertEqual(len(cloud.records), 1)

    def test_active_pomodoro_becomes_interrupted_on_reboot(self):
        device = DeviceSimulator(self.data_dir)
        device.pomodoro.start(10)
        device.pomodoro.tick(3)
        restarted = device.restart()
        self.assertEqual(restarted.pomodoro.status, PomodoroStatus.INTERRUPTED)
        self.assertEqual(
            restarted.pomodoro.state["interruption_reason"], "interrupted_reboot"
        )

    def test_pomodoro_note_keeps_session_id(self):
        device = DeviceSimulator(self.data_dir)
        session_id = device.pomodoro.start(10)
        note = device.record_pomodoro_note(0.05)
        self.assertEqual(note.metadata["kind"], "pomodoro_note")
        self.assertEqual(note.metadata["session_id"], session_id)


if __name__ == "__main__":
    unittest.main()
