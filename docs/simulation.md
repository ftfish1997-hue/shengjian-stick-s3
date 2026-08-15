# Simulator

The Python simulator exercises queue persistence, idempotent upload behavior, restart recovery, and Pomodoro state without hardware or cloud credentials.

## Automated demo

```bash
python3 -m simulator.run demo
```

The demo:

1. places the synthetic device offline;
2. generates two valid test WAV files and atomically queues them;
3. restarts and verifies both items remain;
4. restores connectivity and simulates a server commit followed by a lost response;
5. retries the same event and safely removes the acknowledged local item;
6. runs an accelerated Pomodoro session with a linked synthetic note.

Generated WAV files contain test tones, not speech. Simulator state is stored under the ignored `.simulator-data/` directory.

## Interactive mode

```bash
python3 -m simulator.run interactive
```

Useful commands:

```text
status
offline
online
record 1
sync
pomodoro 10
tick 3
note 0.5
restart
quit
```

The duration arguments generate WAV metadata immediately; the simulator does not wait in real time.

## Browser simulator

`mobile-simulator/` provides a browser-based microphone path and WAV encoder tests. Browser recordings are personal data; keep them local and never add generated audio to Git.

## Hardware tools

- PlatformIO is the supported build path for this firmware.
- M5Burner can restore official firmware.
- UIFlow2 is an alternative official development environment and is not required by Shengjian.
