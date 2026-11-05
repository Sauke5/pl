from __future__ import annotations

from dataclasses import replace

import httpx
import pytest
import respx

from app.services.notifier import TelegramNotifier


@pytest.mark.asyncio
@respx.mock
async def test_telegram_success_contains_no_username(settings):
    configured = replace(settings, telegram_bot_token="test-token", telegram_chat_id="-100123")
    route = respx.post("https://api.telegram.org/bottest-token/sendMessage").mock(
        return_value=httpx.Response(200, json={"ok": True})
    )
    result = await TelegramNotifier(configured).send(
        success=True,
        url="https://example.org/",
        operation="content_update",
        reason="redesign",
        old_values={"fragments": ["old"]},
        new_values={"fragments": ["new"]},
        forced=False,
    )
    assert result.success
    payload = route.calls[0].request.content.decode()
    assert "username" not in payload and "operator" not in payload


@pytest.mark.asyncio
@respx.mock
async def test_telegram_timeout_returns_failure_without_raising(settings):
    configured = replace(settings, telegram_bot_token="test-token", telegram_chat_id="-100123")
    respx.post("https://api.telegram.org/bottest-token/sendMessage").mock(side_effect=httpx.ReadTimeout("timeout"))
    result = await TelegramNotifier(configured).send(
        success=False,
        url="https://example.org/",
        operation="add",
        reason="forced test",
        old_values=None,
        new_values=None,
        forced=True,
        error="probe failed",
        restored=True,
    )
    assert not result.success
