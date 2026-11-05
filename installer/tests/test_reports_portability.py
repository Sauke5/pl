import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pl_reports_config", ROOT / "monitoring/source/scripts/monitoring_summary/config.py")
config = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = config
spec.loader.exec_module(config)


class ReportsPortabilityTests(unittest.TestCase):
    def test_new_installation_does_not_use_an_organization_portal(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=True):
            settings = config.load_settings(Path(temporary))
            self.assertEqual(settings.portal_url, "http://localhost")
            self.assertIsNone(settings.telegram_bot_token)
            self.assertIsNone(settings.telegram_chat_id)

    def test_explicit_portal_url_and_existing_override_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"PORTAL_URL": "https://pl.example.test"}, clear=True):
            self.assertEqual(config.load_settings(Path(temporary)).portal_url, "https://pl.example.test")
            with patch.dict(os.environ, {"MONITORING_PORTAL_URL": "https://reports.example.test"}):
                self.assertEqual(config.load_settings(Path(temporary)).portal_url, "https://reports.example.test")


if __name__ == "__main__":
    unittest.main()
