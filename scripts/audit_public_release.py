#!/usr/bin/env python3
"""Fail closed when a public source tree contains common private artifacts.

Diagnostics intentionally report only a path, rule name, and optional line
number. Matched text is never printed.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import sys


SKIPPED_DIRECTORIES = {
    ".git",
    ".next",
    ".pio",
    ".platformio-core",
    ".venv",
    ".wrangler",
    "__pycache__",
    "dist",
    "node_modules",
}

AUDIO_SUFFIXES = {".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".pcm", ".wav"}
PRIVATE_KEY_SUFFIXES = {".key", ".p12", ".pem", ".pfx"}
DEVICE_DUMP_SUFFIXES = {".bin", ".dump"}


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    rule: str
    line: int | None = None

    def diagnostic(self) -> str:
        location = f"{self.path}:{self.line}" if self.line is not None else self.path
        return f"{location}: {self.rule}"


CONTENT_RULES = (
    (
        "sites-identifier",
        re.compile(r"appg(?:prj|ver|dep)_[A-Za-z0-9]+"),
    ),
    (
        "production-supabase-host",
        re.compile(r"(?<![A-Z0-9_])[a-z]{20}\.supabase\.co", re.IGNORECASE),
    ),
    (
        "private-device-identifier",
        re.compile(r"\bsticks3-\d{3}\b", re.IGNORECASE),
    ),
    (
        "api-key-pattern",
        re.compile(
            r"(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{30,})"
        ),
    ),
)

SECRET_NAME = re.compile(
    r"(?:"
    r"[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|API_KEY|SERVICE_ROLE_KEY)"
    r"|WIFI_SSID"
    r"|NOTION_[A-Z0-9_]+_(?:ID|SOURCE_ID)"
    r")$"
)
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$")


def sensitive_file_rule(relative: Path) -> str | None:
    lowered_parts = {part.lower() for part in relative.parts}
    name = relative.name.lower()
    suffix = relative.suffix.lower()

    if "backups" in lowered_parts or "backup" in lowered_parts:
        return "backup-path"
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        return "environment-file"
    if suffix in AUDIO_SUFFIXES:
        return "audio-file"
    if suffix in PRIVATE_KEY_SUFFIXES:
        return "private-key-file"
    if suffix in DEVICE_DUMP_SUFFIXES:
        return "device-dump"
    if re.search(r"(?:flash|nvs).*(?:\.csv|\.json|\.txt)$", name):
        return "device-dump"
    return None


def contains_private_key_marker(line: str) -> bool:
    marker = "-" * 5 + "BEGIN "
    return marker in line and "PRIVATE KEY" in line


def nonempty_secret_assignment(line: str) -> bool:
    match = ENV_ASSIGNMENT.match(line)
    if match is None or SECRET_NAME.fullmatch(match.group(1)) is None:
        return False
    value = match.group(2).strip()
    if not value:
        return False
    if value[0:1] == value[-1:] and value[0:1] in {"'", '"'}:
        value = value[1:-1].strip()
    return bool(value) and not value.startswith(("<", "${", "$"))


def audit_text(relative: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if nonempty_secret_assignment(line):
            findings.append(Finding(str(relative), "nonempty-secret-assignment", number))
        if contains_private_key_marker(line):
            findings.append(Finding(str(relative), "private-key-material", number))
        for rule, pattern in CONTENT_RULES:
            if pattern.search(line):
                findings.append(Finding(str(relative), rule, number))
    return findings


def iter_files(root: Path):
    for path in sorted(root.rglob("*")):
        if any(part in SKIPPED_DIRECTORIES for part in path.relative_to(root).parts):
            continue
        if path.is_file():
            yield path


def audit(root: Path) -> list[Finding]:
    findings: list[Finding] = []
    for path in iter_files(root):
        relative = path.relative_to(root)
        file_rule = sensitive_file_rule(relative)
        if file_rule:
            findings.append(Finding(str(relative), file_rule))
            continue

        try:
            raw = path.read_bytes()
        except OSError:
            findings.append(Finding(str(relative), "unreadable-file"))
            continue
        if b"\0" in raw:
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(audit_text(relative, text))
    return sorted(set(findings))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", nargs="?", default=".", type=Path)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    if not root.is_dir():
        print("public release audit error: root is not a directory", file=sys.stderr)
        return 2

    findings = audit(root)
    if findings:
        for finding in findings:
            print(finding.diagnostic())
        print(f"public release audit failed: {len(findings)} finding(s)")
        return 1

    print("public release audit passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
