from __future__ import annotations

from pathlib import Path

import pytest

from app.auth.providers import PASSWORD_HASHER
from app.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    secret = tmp_path / "credentials"
    secret.write_text(f"username=admin\npassword_hash={PASSWORD_HASHER.hash('correct horse battery')}\n", encoding="utf-8")
    secret.chmod(0o600)
    return Settings(
        app_name="test", root_path="/admin", data_dir=tmp_path / "data",
        database_url=f"sqlite:///{tmp_path / 'admin.sqlite3'}", credentials_file=secret, auth_provider="local",
        session_cookie="session", session_idle_seconds=3600, cookie_secure=False,
        login_csrf_cookie="login_csrf", login_rate_limit=3, trusted_hosts=("testserver",),
        agent_socket=tmp_path / "agent.sock", agent_timeout_seconds=1,
        agent_restart_timeout_seconds=60,
        report_runner_url="http://report-runner:8080", report_runner_timeout_seconds=1,
        service_allowlist=("prometheus", "websites-admin", "monitoring-admin"),
        restart_allowlist=("prometheus", "websites-admin"), worker_poll_seconds=0.01,
        job_timeout_seconds=2, health_timeout_seconds=0.1, health_poll_seconds=0.01, log_level="INFO",
    )
