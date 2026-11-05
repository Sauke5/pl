from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _csv(name: str) -> tuple[str, ...]:
    return tuple(value.strip() for value in os.getenv(name, "").split(",") if value.strip())


@dataclass(frozen=True, slots=True)
class Settings:
    app_name: str
    root_path: str
    data_dir: Path
    database_url: str
    websites_file: Path
    content_file: Path
    blackbox_file: Path
    backups_dir: Path
    lock_file: Path
    prometheus_url: str
    prometheus_stability_window_seconds: int
    prometheus_content_stability_window_seconds: int
    blackbox_url: str
    blackbox_binary: Path
    session_cookie: str
    session_idle_seconds: int
    cookie_secure: bool
    csrf_cookie: str
    telegram_bot_token: str | None
    telegram_chat_id: str | None
    telegram_proxy_url: str | None
    telegram_timeout_seconds: float
    ssrf_allowlist: tuple[str, ...]
    max_response_bytes: int
    fetch_connect_timeout: float
    fetch_read_timeout: float
    fetch_max_redirects: int
    backup_keep: int
    verify_timeout_seconds: int
    log_level: str
    enable_real_reload: bool
    enable_real_blackbox_validation: bool
    auth_mode: str = "standalone"
    platform_sso_key_file: Path | None = None
    trusted_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "websites-admin", "testserver")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    data_dir = Path(os.getenv("WEBSITES_ADMIN_DATA_DIR", "/app/data"))
    database_path = Path(os.getenv("WEBSITES_ADMIN_DB_PATH", str(data_dir / "websites-admin.sqlite3")))
    return Settings(
        app_name="Управление сайтами",
        root_path=os.getenv("WEBSITES_ADMIN_ROOT_PATH", "/websites").rstrip("/"),
        data_dir=data_dir,
        database_url=os.getenv("WEBSITES_ADMIN_DATABASE_URL", f"sqlite:///{database_path}"),
        websites_file=Path(os.getenv("WEBSITES_FILE", "/config/targets/websites.yml")),
        content_file=Path(os.getenv("CONTENT_FILE", "/config/targets/content.yml")),
        blackbox_file=Path(os.getenv("BLACKBOX_FILE", "/config/blackbox/blackbox.yml")),
        backups_dir=Path(os.getenv("WEBSITES_ADMIN_BACKUPS_DIR", "/app/backups/site-monitoring")),
        lock_file=Path(os.getenv("WEBSITES_ADMIN_LOCK_FILE", str(data_dir / "config.lock"))),
        prometheus_url=os.getenv("PROMETHEUS_URL", "http://prometheus:9090").rstrip("/"),
        prometheus_stability_window_seconds=int(os.getenv("WEBSITES_ADMIN_PROMETHEUS_STABILITY_WINDOW_SECONDS", "120")),
        prometheus_content_stability_window_seconds=int(os.getenv("WEBSITES_ADMIN_CONTENT_STABILITY_WINDOW_SECONDS", "600")),
        blackbox_url=os.getenv("BLACKBOX_URL", "http://blackbox:9115").rstrip("/"),
        blackbox_binary=Path(os.getenv("BLACKBOX_BINARY", "/usr/local/bin/blackbox_exporter")),
        session_cookie=os.getenv("WEBSITES_ADMIN_SESSION_COOKIE", "websites_admin_session"),
        session_idle_seconds=int(os.getenv("WEBSITES_ADMIN_SESSION_IDLE_SECONDS", "28800")),
        cookie_secure=_bool("WEBSITES_ADMIN_COOKIE_SECURE", True),
        csrf_cookie=os.getenv("WEBSITES_ADMIN_LOGIN_CSRF_COOKIE", "websites_admin_login_csrf"),
        telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN") or None,
        telegram_chat_id=(os.getenv("WEBSITES_ADMIN_TELEGRAM_CHAT_ID") or os.getenv("TELEGRAM_CHAT_ID") or None),
        telegram_proxy_url=os.getenv("TELEGRAM_PROXY_URL") or None,
        telegram_timeout_seconds=float(os.getenv("TELEGRAM_TIMEOUT_SECONDS", "5")),
        ssrf_allowlist=_csv("WEBSITES_ADMIN_SSRF_ALLOWLIST"),
        max_response_bytes=int(os.getenv("WEBSITES_ADMIN_MAX_RESPONSE_BYTES", "2097152")),
        fetch_connect_timeout=float(os.getenv("WEBSITES_ADMIN_FETCH_CONNECT_TIMEOUT", "5")),
        fetch_read_timeout=float(os.getenv("WEBSITES_ADMIN_FETCH_READ_TIMEOUT", "10")),
        fetch_max_redirects=int(os.getenv("WEBSITES_ADMIN_FETCH_MAX_REDIRECTS", "5")),
        backup_keep=int(os.getenv("WEBSITES_ADMIN_BACKUP_KEEP", "10")),
        verify_timeout_seconds=int(os.getenv("WEBSITES_ADMIN_VERIFY_TIMEOUT_SECONDS", "90")),
        log_level=os.getenv("WEBSITES_ADMIN_LOG_LEVEL", "INFO").upper(),
        enable_real_reload=_bool("WEBSITES_ADMIN_ENABLE_REAL_RELOAD", True),
        enable_real_blackbox_validation=_bool("WEBSITES_ADMIN_ENABLE_REAL_BLACKBOX_VALIDATION", True),
        auth_mode=os.getenv("WEBSITES_ADMIN_AUTH_MODE", "standalone"),
        trusted_hosts=_csv("WEBSITES_ADMIN_TRUSTED_HOSTS") or ("localhost", "127.0.0.1", "websites-admin", "testserver"),
        platform_sso_key_file=Path(os.environ["WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE"]) if os.getenv("WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE") else None,
    )
