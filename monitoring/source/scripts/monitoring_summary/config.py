from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    base_dir: Path
    data_dir: Path
    prometheus_url: str
    database_path: Path
    reports_dir: Path
    portal_url: str
    report_retention_days: int
    weekly_report_retention_weeks: int
    ram_exclude_instances: frozenset[str]
    telegram_bot_token: str | None
    telegram_chat_id: str | None
    telegram_proxy_url: str | None


@dataclass(frozen=True)
class TelegramSettings:
    bot_token: str | None
    chat_id: str | None
    proxy_url: str | None


def load_env_file(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def read_alertmanager_telegram_settings(
    config_path: Path,
    receiver_name: str = "telegram-silent",
) -> tuple[str | None, str | None, str | None]:
    if not config_path.exists():
        return None, None, None

    text = config_path.read_text()
    escaped_receiver = re.escape(receiver_name)
    block_match = re.search(
        rf"""- name:\s*["']{escaped_receiver}["'](?P<block>.*?)(?:\n  - name:|\ninhibit_rules:|\Z)""",
        text,
        re.S,
    )
    if not block_match:
        return None, None, None

    block = block_match.group("block")

    def match(pattern: str) -> str | None:
        result = re.search(pattern, block)
        return result.group(1) if result else None

    token = match(r"bot_token:\s*[\"']?([^\"'\s]+)")
    if token is None and match(r"bot_token_file:\s*[\"']?([^\"'\s]+)"):
        # The host cron job shares the preserved token with file-backed receivers.
        token = os.environ.get("TELEGRAM_BOT_TOKEN") or None
    chat_id = match(r"chat_id:\s*[\"']?(-?\d+)")
    proxy_url = match(r"proxy_url:\s*[\"']([^\"']+)")
    return token, chat_id, proxy_url


def alertmanager_telegram_settings(
    config_path: Path,
    receiver_name: str,
) -> TelegramSettings:
    token, chat_id, proxy_url = read_alertmanager_telegram_settings(
        config_path,
        receiver_name,
    )
    return TelegramSettings(token, chat_id, proxy_url)


def branch_telegram_settings(base_dir: Path, branch: str) -> TelegramSettings:
    return alertmanager_telegram_settings(
        base_dir / "alertmanager/config/alertmanager.yml",
        f"telegram-branch-{branch}-silent",
    )


def alertmanager_branch_receivers(config_path: Path) -> list[str]:
    if not config_path.exists():
        return []

    branches = {
        match.group(1)
        for match in re.finditer(
            r"""- name:\s*["']telegram-branch-((?![a-z0-9_-]*-disk(?:-|$))[a-z0-9][a-z0-9_-]*)-silent["']""",
            config_path.read_text(),
        )
    }
    return sorted(branches)


def load_settings(base_dir: Path | None = None) -> Settings:
    default_base = Path(__file__).resolve().parents[2]
    base = Path(
        os.environ.get("MONITORING_BASE_DIR", base_dir or default_base)
    ).resolve()
    load_env_file(Path(os.environ.get("MONITORING_RUNTIME_ENV_FILE", base / ".env")))
    data_dir = Path(os.environ.get("MONITORING_DATA_DIR", base / "data"))

    fallback_token, fallback_chat, fallback_proxy = (
        read_alertmanager_telegram_settings(
            base / "alertmanager/config/alertmanager.yml"
        )
    )

    database_path = Path(
        os.environ.get(
            "MONITORING_DB_PATH",
            data_dir / "monitoring_history.sqlite3",
        )
    )
    reports_dir = Path(
        os.environ.get(
            "MONITORING_REPORTS_DIR",
            data_dir / "reports",
        )
    )

    return Settings(
        base_dir=base,
        data_dir=data_dir,
        prometheus_url=os.environ.get(
            "PROMETHEUS_URL", "http://127.0.0.1:9090"
        ),
        database_path=database_path,
        reports_dir=reports_dir,
        portal_url=os.environ.get(
            "MONITORING_PORTAL_URL",
            os.environ.get("PORTAL_URL", "http://localhost"),
        ),
        report_retention_days=int(
            os.environ.get("MONITORING_REPORT_RETENTION_DAYS", "90")
        ),
        weekly_report_retention_weeks=int(
            os.environ.get("MONITORING_WEEKLY_REPORT_RETENTION_WEEKS", "104")
        ),
        ram_exclude_instances=frozenset(
            instance.strip()
            for instance in os.environ.get(
                "MONITORING_RAM_EXCLUDE_INSTANCES",
                "RAPP:9182",
            ).split(",")
            if instance.strip()
        ),
        telegram_bot_token=os.environ.get(
            "TELEGRAM_BOT_TOKEN", fallback_token or ""
        )
        or None,
        telegram_chat_id=os.environ.get(
            "TELEGRAM_CHAT_ID", fallback_chat or ""
        )
        or None,
        telegram_proxy_url=os.environ.get(
            "TELEGRAM_PROXY_URL", fallback_proxy or ""
        )
        or None,
    )
