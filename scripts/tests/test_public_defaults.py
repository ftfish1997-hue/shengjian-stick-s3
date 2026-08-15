from __future__ import annotations

import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


class PublicDefaultsTests(unittest.TestCase):
    def test_example_device_is_used_by_firmware_provisioning_and_seed(self) -> None:
        files = (
            "firmware/include/app_config.h",
            "scripts/provision_device.py",
            "supabase/seed.sql",
        )
        combined = "\n".join(read(path) for path in files)

        self.assertFalse(
            re.search(r"\bsticks3-\d{3}\b", combined),
            "private-style device ID remains in public defaults",
        )
        legacy_simulator_id = "sticks3-" + "sim-001"
        self.assertFalse(
            legacy_simulator_id in combined,
            "legacy simulator device ID remains in public defaults",
        )
        for path in files:
            self.assertTrue("demo-device-001" in read(path), path)

    def test_supabase_project_defaults_are_public_placeholders(self) -> None:
        config = read("supabase/config.toml")
        network_sync = read("firmware/src/network_sync.cpp")

        self.assertTrue(
            'project_id = "shengjian-stick-s3"' in config,
            "public Supabase project ID is not configured",
        )
        self.assertTrue(
            'kUploadHost[] = "YOUR_PROJECT_REF.supabase.co"' in network_sync,
            "firmware upload host is not a public placeholder",
        )
        self.assertFalse(
            re.search(r"https://[a-z]{20}\.supabase\.co", network_sync),
            "firmware must not contain a production Supabase project URL",
        )

    def test_cron_jobs_build_function_urls_from_vault_project_url(self) -> None:
        jobs = {
            "supabase/migrations/202607230004_retry_cron.sql": "retry-failures",
            "supabase/migrations/202607240006_daily_review_cron.sql": "daily-review",
        }

        for path, function_name in jobs.items():
            sql = read(path)
            with self.subTest(path=path):
                self.assertTrue(
                    "where name = 'project_url'" in sql,
                    "Cron URL must read the project URL from Vault",
                )
                self.assertTrue(
                    f"|| '/functions/v1/{function_name}'" in sql,
                    "Cron URL has the wrong function suffix",
                )
                self.assertFalse(
                    re.search(r"https://[a-z]{20}\.supabase\.co", sql),
                    "Cron migration must not contain a production project URL",
                )


if __name__ == "__main__":
    unittest.main()
