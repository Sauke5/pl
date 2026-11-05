from __future__ import annotations

import json
import logging
import re
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from socket import socket
from socketserver import BaseServer, ThreadingMixIn
from typing import Any
from urllib.parse import parse_qs, urlsplit

from .docker import DockerClient, DockerError
from .registry import SERVICES, UnknownServiceError, get_service


LOGGER = logging.getLogger("monitoring-admin-agent")
MAX_BODY_BYTES = 1024
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SERVICE_PATH_RE = re.compile(r"^/v1/services/([a-z0-9-]+)$")
LOG_PATH_RE = re.compile(r"^/v1/services/([a-z0-9-]+)/logs$")
RESTART_PATH_RE = re.compile(r"^/v1/services/([a-z0-9-]+)/restart$")


class AgentHTTPServer(ThreadingMixIn, BaseServer):
    daemon_threads = True
    block_on_close = True

    def __init__(self, inherited_socket: socket, client: DockerClient) -> None:
        super().__init__(inherited_socket.getsockname(), AgentRequestHandler)
        self.client = client
        self.socket = inherited_socket
        self.restart_locks = {service_id: threading.Lock() for service_id in SERVICES}
        self.server_name = "monitoring-admin-agent"
        self.server_port = 0

    def get_request(self) -> tuple[socket, str]:
        connection, _ = self.socket.accept()
        return connection, "unix"

    def fileno(self) -> int:
        return self.socket.fileno()

    def close_request(self, request: socket) -> None:
        request.close()

    def server_close(self) -> None:
        self.socket.close()


class AgentRequestHandler(BaseHTTPRequestHandler):
    server: AgentHTTPServer
    protocol_version = "HTTP/1.1"
    server_version = "MonitoringAdminAgent/1"
    sys_version = ""

    def log_message(self, fmt: str, *args: object) -> None:
        LOGGER.info("http peer=unix " + fmt, *args)

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path == "/v1/overview" and not parsed.query:
            self._overview()
            return
        match = SERVICE_PATH_RE.fullmatch(parsed.path)
        if match and not parsed.query:
            self._inspect(match.group(1))
            return
        match = LOG_PATH_RE.fullmatch(parsed.path)
        if match:
            query = parse_qs(parsed.query, keep_blank_values=True)
            if query != {"tail": ["50"]}:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_tail", "only tail=50 is allowed")
                return
            self._logs(match.group(1))
            return
        self._error(HTTPStatus.NOT_FOUND, "not_found", "endpoint not found")

    def do_POST(self) -> None:
        parsed = urlsplit(self.path)
        match = RESTART_PATH_RE.fullmatch(parsed.path)
        if not match or parsed.query:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "endpoint not found")
            return
        body = self._json_body()
        if body is None:
            return
        if set(body) != {"request_id"} or not isinstance(body["request_id"], str):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "request_id is required")
            return
        request_id = body["request_id"]
        if not REQUEST_ID_RE.fullmatch(request_id):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request_id", "invalid request_id")
            return
        self._restart(match.group(1), request_id)

    def _overview(self) -> None:
        services: list[dict[str, object]] = []
        for service in SERVICES.values():
            try:
                services.append(self.server.client.inspect(service))
            except DockerError:
                services.append(
                    {
                        "service_id": service.service_id,
                        "display_name": service.display_name,
                        "container_name": service.container_name,
                        "status": "unavailable",
                        "running": False,
                        "health": "unknown",
                        "readiness": "unknown",
                        "started_at": None,
                        "uptime_seconds": 0,
                        "restartable": service.restartable,
                        "restart_count": 0,
                    }
                )
        self._json(HTTPStatus.OK, {"services": services})

    def _inspect(self, service_id: str) -> None:
        try:
            result = self.server.client.inspect(get_service(service_id))
        except UnknownServiceError:
            self._error(HTTPStatus.NOT_FOUND, "unknown_service", "unknown service")
        except DockerError:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, "docker_unavailable", "service unavailable")
        else:
            self._json(HTTPStatus.OK, result)

    def _logs(self, service_id: str) -> None:
        try:
            service = get_service(service_id)
            lines = self.server.client.logs(service)
        except UnknownServiceError:
            self._error(HTTPStatus.NOT_FOUND, "unknown_service", "unknown service")
        except DockerError:
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, "docker_unavailable", "logs unavailable")
        else:
            self._json(
                HTTPStatus.OK,
                {"service_id": service.service_id, "tail": 50, "lines": lines},
            )

    def _restart(self, service_id: str, request_id: str) -> None:
        try:
            service = get_service(service_id)
        except UnknownServiceError:
            self._error(HTTPStatus.NOT_FOUND, "unknown_service", "unknown service")
            return
        if not service.restartable:
            LOGGER.warning(
                "audit action=restart result=denied service_id=%s request_id=%s",
                service_id,
                request_id,
            )
            self._error(HTTPStatus.FORBIDDEN, "restart_denied", "restart is not allowed")
            return
        lock = self.server.restart_locks[service_id]
        if not lock.acquire(blocking=False):
            self._error(HTTPStatus.CONFLICT, "restart_in_progress", "restart already in progress")
            return
        try:
            LOGGER.warning(
                "audit action=restart result=started service_id=%s request_id=%s",
                service_id,
                request_id,
            )
            result = self.server.client.restart(service)
        except (DockerError, PermissionError):
            LOGGER.error(
                "audit action=restart result=failed service_id=%s request_id=%s",
                service_id,
                request_id,
            )
            self._error(HTTPStatus.SERVICE_UNAVAILABLE, "restart_failed", "restart failed")
        else:
            LOGGER.warning(
                "audit action=restart result=completed service_id=%s request_id=%s",
                service_id,
                request_id,
            )
            self._json(
                HTTPStatus.OK,
                {"request_id": request_id, **result},
            )
        finally:
            lock.release()

    def _json_body(self) -> dict[str, Any] | None:
        if self.headers.get_content_type() != "application/json":
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_content_type", "JSON required")
            return None
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "")
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_body", "invalid body")
            return None
        if length < 2 or length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "invalid_body", "invalid body size")
            return None
        try:
            value = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "invalid JSON")
            return None
        if not isinstance(value, dict):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "JSON object required")
            return None
        return value

    def _error(self, status: HTTPStatus, code: str, message: str) -> None:
        self._json(status, {"error": {"code": code, "message": message}})

    def _json(self, status: HTTPStatus, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True
