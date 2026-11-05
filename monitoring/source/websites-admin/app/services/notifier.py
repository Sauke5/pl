from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class NotificationResult:
    success: bool
    error: str | None = None


OPERATION_LABELS = {
    "add": "добавлена цель",
    "delete": "удалена цель",
    "content_enable": "включена проверка содержимого",
    "content_disable": "выключена проверка содержимого",
    "content_update": "обновлены контрольные фрагменты",
    "rollback": "выполнен откат конфигурации",
}


def _format_values(values: dict[str, Any] | None) -> str:
    if not values:
        return "—"
    fragments = values.get("fragments")
    if fragments:
        return "\n".join(f"— {item}" for item in fragments)
    enabled = values.get("content_enabled")
    if enabled is not None:
        return "— content-check включён" if enabled else "— content-check выключен"
    return "— конфигурация цели"


class TelegramNotifier:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def send(
        self,
        *,
        success: bool,
        url: str | None,
        operation: str,
        reason: str,
        old_values: dict[str, Any] | None,
        new_values: dict[str, Any] | None,
        forced: bool,
        error: str | None = None,
        restored: bool = False,
    ) -> NotificationResult:
        if not self.settings.telegram_bot_token or not self.settings.telegram_chat_id:
            return NotificationResult(False, "Telegram credentials are not configured")
        heading = "🌐 Изменён мониторинг сайта" if success else "⚠️ Не удалось изменить мониторинг сайта"
        lines = [
            heading,
            "",
            f"Цель: {url or 'общая конфигурация'}",
            f"Действие: {OPERATION_LABELS.get(operation, operation)}",
        ]
        if forced:
            lines.extend(["", "Режим: ПРИНУДИТЕЛЬНОЕ СОХРАНЕНИЕ"])
        if old_values is not None:
            lines.extend(["", "Было:", _format_values(old_values)])
        if new_values is not None:
            lines.extend(["", "Стало:", _format_values(new_values)])
        lines.extend(["", "Причина:", reason])
        if error:
            lines.extend(["", "Ошибка:", error[:600]])
        result = "Изменения применены, проверка успешна" if success else "Операция завершилась ошибкой"
        if restored:
            result = "Предыдущая версия автоматически восстановлена"
        lines.extend(["", "Результат:", result])

        endpoint = f"https://api.telegram.org/bot{self.settings.telegram_bot_token}/sendMessage"
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.telegram_timeout_seconds,
                proxy=self.settings.telegram_proxy_url,
                trust_env=False,
            ) as client:
                response = await client.post(
                    endpoint,
                    json={
                        "chat_id": self.settings.telegram_chat_id,
                        "text": "\n".join(lines),
                        "disable_notification": False,
                    },
                )
                response.raise_for_status()
                payload = response.json()
                if not payload.get("ok"):
                    raise RuntimeError("Telegram API returned ok=false")
            return NotificationResult(True)
        except Exception as exc:
            logger.warning("telegram_notification_failed", extra={"error_type": type(exc).__name__, "url": url})
            return NotificationResult(False, type(exc).__name__)
