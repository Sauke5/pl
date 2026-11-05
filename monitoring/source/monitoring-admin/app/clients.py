from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import httpx


SERVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")


class UpstreamError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class AgentClient:
    def __init__(self, socket_path: Path, timeout: float, services: tuple[str, ...], restartable: tuple[str, ...],
                 restart_timeout: float = 120):
        self.socket_path = socket_path
        self.timeout = timeout
        self.services = frozenset(services)
        self.restartable = frozenset(restartable)
        self.restart_timeout = max(restart_timeout, 60)

    def require_service(self, service_id: str, *, restart: bool = False) -> None:
        allowed = self.restartable if restart else self.services
        if not SERVICE_ID_RE.fullmatch(service_id) or service_id not in allowed:
            raise ValueError("service_not_allowed")

    async def _request(self, method: str, path: str, *, timeout: float | None = None, **kwargs: Any) -> dict[str, Any]:
        transport = httpx.AsyncHTTPTransport(uds=str(self.socket_path))
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://agent", timeout=timeout or self.timeout,
                                         trust_env=False) as client:
                response = await client.request(method, path, **kwargs)
                if response.is_error:
                    try:
                        error = response.json().get("error", {})
                    except ValueError:
                        error = {}
                    raise UpstreamError(str(error.get("code", "agent_request_failed")),
                                        str(error.get("message", "Agent отклонил операцию")))
                data = response.json()
        except UpstreamError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise UpstreamError("agent_unavailable", "Agent управления недоступен") from exc
        if not isinstance(data, dict):
            raise UpstreamError("invalid_agent_response", "Agent вернул некорректный ответ")
        return data

    async def overview(self) -> dict[str, Any]:
        return await self._request("GET", "/v1/overview")

    async def logs(self, service_id: str, tail: int = 50) -> dict[str, Any]:
        self.require_service(service_id)
        del tail
        return await self._request("GET", f"/v1/services/{service_id}/logs", params={"tail": 50})

    async def restart(self, service_id: str, request_id: str) -> dict[str, Any]:
        self.require_service(service_id, restart=True)
        return await self._request("POST", f"/v1/services/{service_id}/restart", timeout=self.restart_timeout,
                                   json={"request_id": request_id})


class ReportRunnerClient:
    def __init__(self, base_url: str, timeout: float):
        self.base_url = base_url
        self.timeout = timeout

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=self.timeout, trust_env=False) as client:
                response = await client.get(path, params=params)
                response.raise_for_status()
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise UpstreamError("report_runner_unavailable", "Сервис отчётов недоступен") from exc
        if not isinstance(data, dict):
            raise UpstreamError("invalid_report_runner_response", "Сервис отчётов вернул некорректный ответ")
        return data

    async def deliveries(self, limit: int) -> dict[str, Any]:
        return await self._get("/internal/admin/deliveries", {"limit": min(max(limit, 1), 100)})

    async def diagnostics(self) -> dict[str, Any]:
        return await self._get("/internal/admin/diagnostics")
