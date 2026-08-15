#!/usr/bin/env python3
"""Validate every JSON file below the supplied paths using the standard library."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def iter_json_files(paths: list[str]):
    for raw_path in paths:
        path = Path(raw_path)
        if path.is_file() and path.suffix == ".json":
            yield path
        elif path.is_dir():
            yield from sorted(path.rglob("*.json"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", help="JSON files or directories")
    args = parser.parse_args()

    files = list(iter_json_files(args.paths))
    if not files:
        raise SystemExit("no JSON files found")

    for path in files:
        with path.open("r", encoding="utf-8") as handle:
            json.load(handle)
        print(f"ok {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
