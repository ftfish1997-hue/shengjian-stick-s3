from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
AUDITOR = ROOT / "scripts" / "audit_public_release.py"


def run_audit(directory: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(AUDITOR), str(directory)],
        check=False,
        capture_output=True,
        text=True,
    )


class PublicReleaseAuditTests(unittest.TestCase):
    def test_accepts_empty_example_secrets_and_public_placeholders(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "README.md").write_text(
                "Use YOUR_PROJECT_REF.supabase.co for your own deployment.\n",
                encoding="utf-8",
            )
            (root / ".env.example").write_text(
                "DEVICE_ID=demo-device-001\n"
                "WIFI_PASSWORD=\n"
                "DASHSCOPE_API_KEY=\n"
                "DASHBOARD_READ_TOKEN=\n",
                encoding="utf-8",
            )

            result = run_audit(root)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("public release audit passed", result.stdout)

    def test_rejects_secret_assignments_without_echoing_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            secret_value = "synthetic-secret-value-for-test"
            (root / "config.txt").write_text(
                f"DASHBOARD_READ_TOKEN={secret_value}\n",
                encoding="utf-8",
            )

            result = run_audit(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("nonempty-secret-assignment", result.stdout)
            self.assertNotIn(secret_value, result.stdout + result.stderr)

    def test_rejects_hosting_ids_and_production_style_supabase_hosts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sites_id = "appg" + "prj_" + "0123456789abcdef"
            project_host = "abcdefghijklmnopqrst" + ".supabase.co"
            (root / "hosting.json").write_text(
                f'{{"project":"{sites_id}","url":"https://{project_host}"}}\n',
                encoding="utf-8",
            )

            result = run_audit(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("sites-identifier", result.stdout)
            self.assertIn("production-supabase-host", result.stdout)
            self.assertNotIn(sites_id, result.stdout + result.stderr)
            self.assertNotIn(project_host, result.stdout + result.stderr)

    def test_rejects_private_key_material_and_sensitive_file_types(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "recording.wav").write_bytes(b"RIFF synthetic")
            (root / "device-flash.bin").write_bytes(b"synthetic")
            private_key_marker = "-" * 5 + "BEGIN " + "PRIVATE KEY" + "-" * 5
            (root / "identity.pem").write_text(
                private_key_marker + "\nsynthetic\n",
                encoding="utf-8",
            )

            result = run_audit(root)

            self.assertEqual(result.returncode, 1)
            self.assertIn("audio-file", result.stdout)
            self.assertIn("device-dump", result.stdout)
            self.assertIn("private-key-file", result.stdout)
            self.assertNotIn("synthetic", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
