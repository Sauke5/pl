from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.config import Settings
from app.repositories.config import ConfigRepository


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        app_name="test",
        root_path="/websites",
        data_dir=tmp_path / "data",
        database_url=f"sqlite:///{tmp_path / 'test.sqlite3'}",
        websites_file=tmp_path / "websites.yml",
        content_file=tmp_path / "content.yml",
        blackbox_file=tmp_path / "blackbox.yml",
        backups_dir=tmp_path / "backups",
        lock_file=tmp_path / "data" / "config.lock",
        prometheus_url="http://prometheus:9090",
        prometheus_stability_window_seconds=120,
        prometheus_content_stability_window_seconds=600,
        blackbox_url="http://blackbox:9115",
        blackbox_binary=Path(os.getenv("BLACKBOX_BINARY", "/usr/local/bin/blackbox_exporter")),
        session_cookie="session",
        session_idle_seconds=28800,
        cookie_secure=True,
        csrf_cookie="login_csrf",
        telegram_bot_token=None,
        telegram_chat_id=None,
        telegram_proxy_url=None,
        telegram_timeout_seconds=1,
        ssrf_allowlist=(),
        max_response_bytes=1024,
        fetch_connect_timeout=1,
        fetch_read_timeout=1,
        fetch_max_redirects=2,
        backup_keep=3,
        verify_timeout_seconds=2,
        log_level="INFO",
        enable_real_reload=False,
        enable_real_blackbox_validation=False,
    )


@pytest.fixture
def repository(settings: Settings) -> ConfigRepository:
    settings.websites_file.write_text(
        """# keep websites comment
- targets:
    - https://example.org/
  labels:
    role: web-app
    location: hq
    env: prod
    site: example
    module: http_2xx
    custom_label: preserve-me
""",
        encoding="utf-8",
    )
    settings.content_file.write_text(
        """# keep content comment
- targets:
    - https://example.org/
  labels:
    role: web-app
    location: hq
    env: prod
    site: example
    module: http_content_existing
""",
        encoding="utf-8",
    )
    settings.blackbox_file.write_text(
        """# keep blackbox comment
modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      valid_status_codes: [200, 204]
      method: GET
      preferred_ip_protocol: ip4
      headers:
        X-Preserved-Test: keep
  http_content_existing:
    prober: http
    timeout: 7s
    http:
      valid_status_codes: [200]
      method: GET
      preferred_ip_protocol: ip4
      fail_if_body_not_matches_regexp:
        - 'Existing fragment'
      fail_if_body_matches_regexp:
        - '(?i)404 Not Found'
""",
        encoding="utf-8",
    )
    return ConfigRepository(settings.websites_file, settings.content_file, settings.blackbox_file)
