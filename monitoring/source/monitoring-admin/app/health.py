from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any

import httpx


# URLs are code-owned, never accepted from a browser request. This is deliberately not a generic URL checker.
HEALTH_ENDPOINTS: dict[str, str] = {
    "prometheus": "http://prometheus:9090/-/ready",
    "grafana": "http://grafana:3000/api/health",
    "alertmanager": "http://alertmanager:9093/-/ready",
    "snmp-exporter": "http://snmp-exporter:9116/-/healthy",
    "blackbox": "http://blackbox:9115/-/healthy",
    "veeam-exporter": "http://veeam-exporter:9469/health",
    "loki": "http://loki:3100/ready",
    "dozzle": "http://dozzle:8080/admin/logs/healthcheck",
    "cadvisor": "http://cadvisor:8080/cadvisor/healthz",
    "alloy": "http://alloy:12345/-/ready",
    "report-runner": "http://report-runner:8080/health",
    "websites-admin": "http://websites-admin:8080/health",
    "nginx": "http://nginx/internal/health",
    "monitoring-admin": "http://monitoring-admin:8080/health",
}


@dataclass(frozen=True, slots=True)
class HealthResult:
    service_id: str
    status: str
    status_code: int | None
    latency_ms: int | None
    error_code: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"service_id": self.service_id, "status": self.status, "status_code": self.status_code,
                "latency_ms": self.latency_ms, "error_code": self.error_code}


class ServiceHealthClient:
    def __init__(self, timeout: float, poll_seconds: float, endpoints: dict[str, str] | None = None):
        self.timeout = timeout
        self.poll_seconds = poll_seconds
        self.endpoints = dict(endpoints or HEALTH_ENDPOINTS)

    async def check(self, service_id: str) -> HealthResult:
        url = self.endpoints.get(service_id)
        if url is None:
            return HealthResult(service_id, "not_configured", None, None)
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=False, trust_env=False) as client:
                response = await client.get(url)
            latency = int((time.monotonic() - started) * 1000)
            return HealthResult(service_id, "healthy" if response.is_success else "unhealthy",
                                response.status_code, latency, None if response.is_success else "http_error")
        except httpx.TimeoutException:
            return HealthResult(service_id, "unhealthy", None, int((time.monotonic() - started) * 1000), "timeout")
        except httpx.HTTPError:
            return HealthResult(service_id, "unhealthy", None, int((time.monotonic() - started) * 1000), "connection_error")

    async def check_all(self, service_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
        results = await asyncio.gather(*(self.check(item) for item in service_ids))
        return {item.service_id: item.as_dict() for item in results}

    async def wait_ready(self, service_id: str, deadline_seconds: float) -> HealthResult:
        if service_id not in self.endpoints:
            return await self.check(service_id)
        deadline = time.monotonic() + deadline_seconds
        result = await self.check(service_id)
        while result.status != "healthy" and time.monotonic() < deadline:
            await asyncio.sleep(min(self.poll_seconds, max(deadline - time.monotonic(), 0)))
            result = await self.check(service_id)
        return result
