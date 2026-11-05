from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from app.config import Settings
from app.repositories.config import WebsiteTarget

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class TargetStatus:
    state: str
    state_class: str
    description: str
    http_status: int | None = None
    content_ok: bool | None = None
    checked_at: datetime | None = None
    latency_seconds: float | None = None
    ssl_days: int | None = None
    response_bytes: int | None = None


class PrometheusUnavailable(RuntimeError):
    pass


def _vector(payload: dict[str, Any]) -> dict[str, float]:
    if payload.get("status") != "success":
        raise PrometheusUnavailable(str(payload.get("error") or "Prometheus query failed"))
    result: dict[str, float] = {}
    for item in payload.get("data", {}).get("result", []):
        instance = item.get("metric", {}).get("instance")
        value = item.get("value", [None, None])[1]
        if instance is None or value is None:
            continue
        try:
            result[str(instance)] = float(value)
        except (TypeError, ValueError):
            continue
    return result


class PrometheusClient:
    QUERIES = {
        "http_success": 'probe_success{job="blackbox-http"}',
        "content_success": 'probe_success{job="blackbox-content"}',
        "http_status": 'probe_http_status_code{job="blackbox-http"}',
        "latency": 'probe_duration_seconds{job="blackbox-http"}',
        "ssl_expiry": 'probe_ssl_earliest_cert_expiry{job="blackbox-http"}',
        "body_length": 'probe_http_uncompressed_body_length{job="blackbox-http"}',
        "checked_at": 'timestamp(probe_success{job="blackbox-http"})',
    }

    def __init__(self, settings: Settings):
        self.settings = settings

    @property
    def queries(self) -> dict[str, str]:
        http_window = self.settings.prometheus_stability_window_seconds
        content_window = self.settings.prometheus_content_stability_window_seconds
        return {
            **self.QUERIES,
            "http_recent_success": f'max_over_time(probe_success{{job="blackbox-http"}}[{http_window}s])',
            "content_recent_success": f'max_over_time(probe_success{{job="blackbox-content"}}[{content_window}s])',
        }

    async def query(self, expression: str) -> dict[str, float]:
        try:
            async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
                response = await client.get(f"{self.settings.prometheus_url}/api/v1/query", params={"query": expression})
                response.raise_for_status()
                return _vector(response.json())
        except (httpx.HTTPError, ValueError, PrometheusUnavailable) as exc:
            raise PrometheusUnavailable(str(exc)) from exc

    async def status_for(self, targets: list[WebsiteTarget]) -> dict[str, TargetStatus]:
        try:
            results = await asyncio.gather(*(self.query(expression) for expression in self.queries.values()))
        except PrometheusUnavailable as exc:
            logger.warning("prometheus_status_unavailable", extra={"error_type": type(exc).__name__})
            return {
                target.url: TargetStatus(
                    state="Данные Prometheus временно недоступны",
                    state_class="unknown",
                    description="Не удалось получить актуальное состояние из Prometheus.",
                )
                for target in targets
            }

        metrics = dict(zip(self.queries, results, strict=True))
        now = datetime.now(timezone.utc).timestamp()
        statuses: dict[str, TargetStatus] = {}
        for target in targets:
            if target.config_error:
                statuses[target.url] = TargetStatus(
                    state="Ошибка конфигурации",
                    state_class="error",
                    description=target.config_error,
                )
                continue

            http_success = metrics["http_success"].get(target.url)
            http_recent_success = metrics["http_recent_success"].get(target.url)
            http_code_value = metrics["http_status"].get(target.url)
            latency = metrics["latency"].get(target.url)
            body = metrics["body_length"].get(target.url)
            checked_timestamp = metrics["checked_at"].get(target.url)
            expiry = metrics["ssl_expiry"].get(target.url)
            base = TargetStatus(
                state="Ожидается первая проверка",
                state_class="pending",
                description="Prometheus ещё не записал результат первой проверки.",
                http_status=int(http_code_value) if http_code_value is not None else None,
                checked_at=datetime.fromtimestamp(checked_timestamp, timezone.utc) if checked_timestamp else None,
                latency_seconds=latency,
                ssl_days=max(0, int((expiry - now) // 86400)) if expiry is not None else None,
                response_bytes=int(body) if body is not None else None,
            )
            if http_success is None:
                statuses[target.url] = base
                continue
            if http_success < 0.5 and http_recent_success is not None and http_recent_success >= 0.5:
                base.state = "Нестабильная доступность"
                base.state_class = "unstable"
                base.description = (
                    "Последняя HTTP-проверка не прошла, но за последние "
                    f"{self.settings.prometheus_stability_window_seconds // 60} мин. сайт отвечал успешно."
                )
                statuses[target.url] = base
                continue
            if http_success < 0.5:
                base.state = "Ошибка доступности"
                base.state_class = "error"
                base.description = (
                    f"HTTP-проверка завершилась с кодом {base.http_status}."
                    if base.http_status
                    else "Сайт не прошёл HTTP-, DNS- или TLS-проверку."
                )
                statuses[target.url] = base
                continue
            if not target.content_enabled:
                base.state = "Проверка содержимого выключена"
                base.state_class = "disabled"
                base.description = "HTTP-проверка успешна, контроль содержимого не настроен."
                base.content_ok = None
                statuses[target.url] = base
                continue
            content_success = metrics["content_success"].get(target.url)
            content_recent_success = metrics["content_recent_success"].get(target.url)
            if content_success is None:
                base.state = "Ожидается первая проверка"
                base.state_class = "pending"
                base.description = "HTTP-проверка успешна; ожидается первый content-check."
                statuses[target.url] = base
                continue
            if content_success < 0.5 and content_recent_success is not None and content_recent_success >= 0.5:
                base.state = "Нестабильная content-проверка"
                base.state_class = "unstable"
                base.description = (
                    "Последняя content-проверка не прошла, но за последние "
                    f"{self.settings.prometheus_content_stability_window_seconds // 60} мин. контрольные фрагменты находились."
                )
                base.content_ok = None
                statuses[target.url] = base
                continue
            if content_success < 0.5:
                base.state = "Изменилось содержимое"
                base.state_class = "warning"
                base.description = "Один или несколько обязательных фрагментов не найдены либо обнаружена страница ошибки."
                base.content_ok = False
                statuses[target.url] = base
                continue
            base.state = "Исправен"
            base.state_class = "ok"
            base.description = "HTTP-проверка и все контрольные фрагменты прошли проверку."
            base.content_ok = True
            statuses[target.url] = base
        return statuses

    async def ready(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as client:
                response = await client.get(f"{self.settings.prometheus_url}/-/ready")
                return response.status_code == 200
        except httpx.HTTPError:
            return False
