"""Command-line entry point for the host-side StickS3 simulator."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

from .core import DeviceSimulator, FakeCloud


def print_status(device: DeviceSimulator) -> None:
    print(json.dumps(device.status(), ensure_ascii=False, indent=2))


def run_demo(data_dir: Path) -> None:
    cloud = FakeCloud()
    device = DeviceSimulator(data_dir, cloud=cloud)
    print(f"模拟数据目录: {data_dir}")

    print("\n[1] 断网并录制两条语音")
    device.set_online(False)
    first = device.record(0.15)
    second = device.record(0.20)
    print(f"已保存: {first.event_id}, {second.event_id}")
    print_status(device)

    print("\n[2] 模拟设备重启，队列应保留")
    device = device.restart()
    print_status(device)

    print("\n[3] 恢复网络；服务器接收第一条后丢失响应")
    device.set_online(True)
    cloud.drop_next_response = True
    print(json.dumps(device.sync(), ensure_ascii=False, indent=2))
    print_status(device)

    print("\n[4] 再次同步；第一条以 duplicate=true 安全确认")
    print(json.dumps(device.sync(), ensure_ascii=False, indent=2))
    print_status(device)

    print("\n[5] 启动 5 秒加速番茄钟并录制关联备注")
    session_id = device.pomodoro.start(5)
    device.pomodoro.tick(2)
    note = device.record_pomodoro_note(0.10)
    device.pomodoro.tick(3)
    print(f"session_id={session_id}, note_event_id={note.event_id}")
    print(json.dumps(device.sync(), ensure_ascii=False, indent=2))
    print_status(device)

    print("\n模拟闭环完成。")


def run_interactive(data_dir: Path) -> None:
    cloud = FakeCloud()
    device = DeviceSimulator(data_dir, cloud=cloud, recover_after_reboot=True)
    print(f"StickS3 模拟器，数据目录: {data_dir}")
    print("输入 help 查看命令。")
    while True:
        try:
            raw = input("sticks3> ").strip()
        except EOFError:
            print()
            break
        if not raw:
            continue
        parts = raw.split()
        command = parts[0].lower()
        try:
            if command in {"quit", "exit"}:
                break
            if command == "help":
                print(
                    "status | offline | online | record <seconds> | sync | "
                    "drop-response | pomodoro <seconds> | tick <seconds> | "
                    "pause | resume | note <seconds> | restart | quit"
                )
            elif command == "status":
                print_status(device)
            elif command == "offline":
                device.set_online(False)
                print("网络已断开")
            elif command == "online":
                device.set_online(True)
                print("网络已恢复")
            elif command == "record":
                item = device.record(float(parts[1]) if len(parts) > 1 else 1.0)
                print(f"已保存，待同步: {item.event_id}")
            elif command == "sync":
                print(json.dumps(device.sync(), ensure_ascii=False, indent=2))
            elif command == "drop-response":
                cloud.drop_next_response = True
                print("下一次成功入库后的响应将丢失")
            elif command == "pomodoro":
                seconds = int(parts[1]) if len(parts) > 1 else 1_500
                print(f"番茄钟已开始: {device.pomodoro.start(seconds)}")
            elif command == "tick":
                seconds = int(parts[1]) if len(parts) > 1 else 1
                print(f"番茄钟状态: {device.pomodoro.tick(seconds).value}")
            elif command == "pause":
                device.pomodoro.pause()
                print("番茄钟已暂停")
            elif command == "resume":
                device.pomodoro.resume()
                print("番茄钟已恢复")
            elif command == "note":
                item = device.record_pomodoro_note(
                    float(parts[1]) if len(parts) > 1 else 1.0
                )
                print(f"番茄备注已保存: {item.event_id}")
            elif command == "restart":
                device = device.restart()
                print("设备已重启")
            else:
                print("未知命令，输入 help")
        except (IndexError, TypeError, ValueError, RuntimeError, OSError) as exc:
            print(f"错误: {exc}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["demo", "interactive"], nargs="?", default="demo")
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args()

    if args.data_dir:
        data_dir = args.data_dir
    elif args.mode == "interactive":
        data_dir = Path(".simulator-data/interactive")
    else:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        data_dir = Path(f".simulator-data/demo-{stamp}")

    if args.mode == "interactive":
        run_interactive(data_dir)
    else:
        run_demo(data_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
