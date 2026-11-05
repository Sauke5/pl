from __future__ import annotations

from app.config import get_settings


def test_dedicated_telegram_chat_takes_precedence(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-1000000000001")
    monkeypatch.setenv("WEBSITES_ADMIN_TELEGRAM_CHAT_ID", "-1000000000002")
    get_settings.cache_clear()
    try:
        assert get_settings().telegram_chat_id == "-1000000000002"
    finally:
        get_settings.cache_clear()


def test_generic_telegram_chat_remains_fallback(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-1000000000001")
    monkeypatch.delenv("WEBSITES_ADMIN_TELEGRAM_CHAT_ID", raising=False)
    get_settings.cache_clear()
    try:
        assert get_settings().telegram_chat_id == "-1000000000001"
    finally:
        get_settings.cache_clear()


def test_trusted_hosts_default_is_local_and_explicit_host_is_configurable(monkeypatch):
    monkeypatch.delenv("WEBSITES_ADMIN_TRUSTED_HOSTS", raising=False)
    get_settings.cache_clear()
    try:
        assert get_settings().trusted_hosts == ("localhost", "127.0.0.1", "websites-admin", "testserver")
        monkeypatch.setenv("WEBSITES_ADMIN_TRUSTED_HOSTS", "portal.example.test,websites-admin")
        get_settings.cache_clear()
        assert get_settings().trusted_hosts == ("portal.example.test", "websites-admin")
    finally:
        get_settings.cache_clear()
