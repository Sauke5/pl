from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str, default: str) -> tuple[str, ...]:
    return tuple(item.strip() for item in os.getenv(name, default).split(",") if item.strip())


DEFAULT_SERVICES = (
    "prometheus", "grafana", "alertmanager", "snmp-exporter", "blackbox",
    "veeam-exporter", "loki", "docker-socket-proxy", "dozzle", "cadvisor", "alloy",
    "report-runner", "websites-admin", "nginx",
    "monitoring-admin", "monitoring-admin-worker",
)
DEFAULT_RESTARTABLE = tuple(item for item in DEFAULT_SERVICES if item not in {"nginx", "monitoring-admin", "monitoring-admin-worker"})


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str
    root_path: str
    data_dir: Path
    database_url: str
    credentials_file: Path
    auth_provider: str
    session_cookie: str
    session_idle_seconds: int
    cookie_secure: bool
    login_csrf_cookie: str
    login_rate_limit: int
    trusted_hosts: tuple[str, ...]
    agent_socket: Path
    agent_timeout_seconds: float
    agent_restart_timeout_seconds: float
    report_runner_url: str
    report_runner_timeout_seconds: float
    service_allowlist: tuple[str, ...]
    restart_allowlist: tuple[str, ...]
    worker_poll_seconds: float
    job_timeout_seconds: int
    health_timeout_seconds: float
    health_poll_seconds: float
    log_level: str
    gateway_key_file: Path = Path("/run/secrets/monitoring_admin_gateway_key")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    data_dir = Path(os.getenv("MONITORING_ADMIN_DATA_DIR", "/app/data"))
    db_path = Path(os.getenv("MONITORING_ADMIN_DB_PATH", str(data_dir / "monitoring-admin.sqlite3")))
    return Settings(
        app_name="Управление мониторингом",
        root_path=os.getenv("MONITORING_ADMIN_ROOT_PATH", "/admin").rstrip("/"),
        data_dir=data_dir,
        database_url=os.getenv("MONITORING_ADMIN_DATABASE_URL", f"sqlite:///{db_path}"),
        credentials_file=Path(os.getenv("MONITORING_ADMIN_CREDENTIALS_FILE", "/run/secrets/monitoring_admin_credentials")),
        auth_provider=os.getenv("MONITORING_ADMIN_AUTH_PROVIDER", "local").lower(),
        session_cookie=os.getenv("MONITORING_ADMIN_SESSION_COOKIE", "monitoring_admin_session"),
        session_idle_seconds=int(os.getenv("MONITORING_ADMIN_SESSION_IDLE_SECONDS", "28800")),
        cookie_secure=_bool("MONITORING_ADMIN_COOKIE_SECURE", True),
        login_csrf_cookie=os.getenv("MONITORING_ADMIN_LOGIN_CSRF_COOKIE", "monitoring_admin_login_csrf"),
        login_rate_limit=int(os.getenv("MONITORING_ADMIN_LOGIN_RATE_LIMIT", "10")),
        trusted_hosts=_csv("MONITORING_ADMIN_TRUSTED_HOSTS", "localhost,127.0.0.1,monitoring-admin,testserver"),
        agent_socket=Path(os.getenv("MONITORING_ADMIN_AGENT_SOCKET", "/run/monitoring-admin/agent.sock")),
        agent_timeout_seconds=float(os.getenv("MONITORING_ADMIN_AGENT_TIMEOUT_SECONDS", "10")),
        agent_restart_timeout_seconds=float(os.getenv("MONITORING_ADMIN_AGENT_RESTART_TIMEOUT_SECONDS", "120")),
        report_runner_url=os.getenv("MONITORING_ADMIN_REPORT_RUNNER_URL", "http://report-runner:8080").rstrip("/"),
        report_runner_timeout_seconds=float(os.getenv("MONITORING_ADMIN_REPORT_RUNNER_TIMEOUT_SECONDS", "5")),
        service_allowlist=_csv("MONITORING_ADMIN_SERVICES", ",".join(DEFAULT_SERVICES)),
        restart_allowlist=_csv("MONITORING_ADMIN_RESTARTABLE_SERVICES", ",".join(DEFAULT_RESTARTABLE)),
        worker_poll_seconds=float(os.getenv("MONITORING_ADMIN_WORKER_POLL_SECONDS", "0.5")),
        job_timeout_seconds=int(os.getenv("MONITORING_ADMIN_JOB_TIMEOUT_SECONDS", "120")),
        health_timeout_seconds=float(os.getenv("MONITORING_ADMIN_HEALTH_TIMEOUT_SECONDS", "5")),
        health_poll_seconds=float(os.getenv("MONITORING_ADMIN_HEALTH_POLL_SECONDS", "2")),
        log_level=os.getenv("MONITORING_ADMIN_LOG_LEVEL", "INFO").upper(),
        gateway_key_file=Path(os.getenv("MONITORING_ADMIN_GATEWAY_KEY_FILE", "/run/secrets/monitoring_admin_gateway_key")),
    )
