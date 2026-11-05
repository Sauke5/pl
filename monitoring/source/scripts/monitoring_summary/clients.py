from __future__ import annotations

import http.client
import json
import mimetypes
import socket
import ssl
import uuid
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any


class Socks5HTTPSConnection(http.client.HTTPSConnection):
    def __init__(
        self,
        host: str,
        *,
        proxy_url: str,
        timeout: float | None = socket._GLOBAL_DEFAULT_TIMEOUT,
        context: ssl.SSLContext | None = None,
    ):
        super().__init__(
            host,
            timeout=timeout,
            context=context,
        )
        self.proxy = urllib.parse.urlparse(proxy_url)

    def connect(self) -> None:
        if self.proxy.scheme not in {"socks5", "socks5h"}:
            raise RuntimeError(f"Unsupported proxy scheme: {self.proxy.scheme}")
        if not self.proxy.hostname or not self.proxy.port:
            raise RuntimeError(f"Invalid SOCKS5 proxy URL: {self.proxy.geturl()}")

        sock = socket.create_connection(
            (self.proxy.hostname, self.proxy.port),
            self.timeout,
            self.source_address,
        )
        try:
            self._socks5_connect(sock)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise

    def _socks5_connect(self, sock: socket.socket) -> None:
        username = urllib.parse.unquote(self.proxy.username or "")
        password = urllib.parse.unquote(self.proxy.password or "")
        methods = b"\x00"
        if username or password:
            methods += b"\x02"
        sock.sendall(b"\x05" + bytes([len(methods)]) + methods)
        response = self._read_exact(sock, 2)
        if response[0] != 5:
            raise RuntimeError("Invalid SOCKS5 proxy response.")
        if response[1] == 0xFF:
            raise RuntimeError("SOCKS5 proxy rejected authentication methods.")
        if response[1] == 0x02:
            user = username.encode()
            password_bytes = password.encode()
            if len(user) > 255 or len(password_bytes) > 255:
                raise RuntimeError("SOCKS5 credentials are too long.")
            sock.sendall(
                b"\x01"
                + bytes([len(user)])
                + user
                + bytes([len(password_bytes)])
                + password_bytes
            )
            auth_response = self._read_exact(sock, 2)
            if auth_response != b"\x01\x00":
                raise RuntimeError("SOCKS5 proxy authentication failed.")
        elif response[1] != 0x00:
            raise RuntimeError("SOCKS5 proxy selected an unsupported auth method.")

        host = self.host.encode("idna")
        if len(host) > 255:
            raise RuntimeError("Target host name is too long for SOCKS5.")
        port = self.port or 443
        request = (
            b"\x05\x01\x00\x03"
            + bytes([len(host)])
            + host
            + port.to_bytes(2, "big")
        )
        sock.sendall(request)

        reply = self._read_exact(sock, 4)
        if reply[0] != 5 or reply[1] != 0:
            raise RuntimeError(f"SOCKS5 proxy connect failed with code {reply[1]}.")
        address_type = reply[3]
        if address_type == 1:
            self._read_exact(sock, 4)
        elif address_type == 3:
            length = self._read_exact(sock, 1)[0]
            self._read_exact(sock, length)
        elif address_type == 4:
            self._read_exact(sock, 16)
        else:
            raise RuntimeError("SOCKS5 proxy returned invalid address type.")
        self._read_exact(sock, 2)

    @staticmethod
    def _read_exact(sock: socket.socket, size: int) -> bytes:
        chunks = bytearray()
        while len(chunks) < size:
            chunk = sock.recv(size - len(chunks))
            if not chunk:
                raise RuntimeError("SOCKS5 proxy closed the connection.")
            chunks.extend(chunk)
        return bytes(chunks)


class Socks5HTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, proxy_url: str):
        super().__init__()
        self.proxy_url = proxy_url

    def https_open(self, req: urllib.request.Request) -> Any:
        def connection_factory(host: str, **kwargs: Any) -> Socks5HTTPSConnection:
            kwargs.pop("check_hostname", None)
            return Socks5HTTPSConnection(
                host,
                proxy_url=self.proxy_url,
                **kwargs,
            )

        return self.do_open(
            connection_factory,
            req,
        )


class PrometheusClient:
    def __init__(self, base_url: str, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def query(self, query: str) -> list[dict[str, Any]]:
        url = self.base_url + "/api/v1/query?" + urllib.parse.urlencode({"query": query})
        return self._request(url, self.timeout)

    def query_range(
        self,
        query: str,
        start: datetime,
        end: datetime,
        step: str = "5m",
    ) -> list[dict[str, Any]]:
        params = {
            "query": query,
            "start": int(start.timestamp()),
            "end": int(end.timestamp()),
            "step": step,
        }
        url = self.base_url + "/api/v1/query_range?" + urllib.parse.urlencode(params)
        return self._request(url, max(self.timeout, 60))

    @staticmethod
    def _decode(response: Any) -> dict[str, Any]:
        return json.loads(response.read().decode())

    def _request(self, url: str, timeout: int) -> list[dict[str, Any]]:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            payload = self._decode(response)

        if payload.get("status") != "success":
            raise RuntimeError(f"Prometheus API error: {payload}")

        return payload["data"]["result"]


class TelegramAPIError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        error_code: int | None = None,
        retry_after: int | None = None,
    ):
        super().__init__(message)
        self.error_code = error_code
        self.retry_after = retry_after


class TelegramClient:
    def __init__(
        self,
        bot_token: str,
        chat_id: str,
        proxy_url: str | None = None,
    ):
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.proxy_url = proxy_url

    def send(self, message: str, silent: bool = True) -> dict[str, Any]:
        api_url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        data = urllib.parse.urlencode(
            {
                "chat_id": self.chat_id,
                "text": message,
                "parse_mode": "HTML",
                "disable_notification": str(silent).lower(),
            }
        ).encode()

        request = urllib.request.Request(api_url, data=data, method="POST")
        return self._open_json(request, timeout=30)

    def send_document(
        self,
        path: Path,
        caption: str | None = None,
        silent: bool = True,
    ) -> dict[str, Any]:
        boundary = f"----monitoring-{uuid.uuid4().hex}"
        safe_filename = path.name.replace('"', "_").replace("\r", "_").replace("\n", "_")
        content_type = (
            mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        )
        body = bytearray()

        def add_field(name: str, value: str) -> None:
            body.extend(f"--{boundary}\r\n".encode())
            body.extend(
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            )
            body.extend(value.encode())
            body.extend(b"\r\n")

        add_field("chat_id", self.chat_id)
        add_field("disable_notification", str(silent).lower())
        if caption:
            add_field("caption", caption)
            add_field("parse_mode", "HTML")

        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            (
                'Content-Disposition: form-data; name="document"; '
                f'filename="{safe_filename}"\r\n'
            ).encode()
        )
        body.extend(f"Content-Type: {content_type}\r\n\r\n".encode())
        body.extend(path.read_bytes())
        body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode())

        api_url = f"https://api.telegram.org/bot{self.bot_token}/sendDocument"
        request = urllib.request.Request(
            api_url,
            data=bytes(body),
            method="POST",
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        return self._open_json(request, timeout=60)

    def _open_json(
        self,
        request: urllib.request.Request,
        timeout: int,
    ) -> dict[str, Any]:
        try:
            with self._opener().open(request, timeout=timeout) as response:
                try:
                    payload = json.loads(response.read().decode())
                except json.JSONDecodeError as exc:
                    raise TelegramAPIError(
                        "Telegram API returned a non-JSON response"
                    ) from exc
                return self._validate_payload(payload)
        except urllib.error.HTTPError as exc:
            try:
                body = exc.read().decode(errors="replace")
            finally:
                exc.close()
            try:
                payload = json.loads(body)
            except json.JSONDecodeError:
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            parameters = payload.get("parameters") or {}
            if not isinstance(parameters, dict):
                parameters = {}
            description = payload.get("description") or body
            raise TelegramAPIError(
                f"Telegram API returned HTTP {exc.code}: {description}",
                error_code=payload.get("error_code", exc.code),
                retry_after=parameters.get("retry_after"),
            ) from exc

    @staticmethod
    def _validate_payload(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise TelegramAPIError("Telegram API returned an invalid JSON payload")
        if payload.get("ok") is True:
            return payload
        parameters = payload.get("parameters") or {}
        if not isinstance(parameters, dict):
            parameters = {}
        raise TelegramAPIError(
            f"Telegram API rejected request: {payload.get('description') or 'unknown error'}",
            error_code=payload.get("error_code"),
            retry_after=parameters.get("retry_after"),
        )

    def _opener(self) -> urllib.request.OpenerDirector:
        if not self.proxy_url:
            return urllib.request.build_opener()
        if urllib.parse.urlparse(self.proxy_url).scheme in {"socks5", "socks5h"}:
            return urllib.request.build_opener(Socks5HTTPSHandler(self.proxy_url))
        return urllib.request.build_opener(
            urllib.request.ProxyHandler(
                {"http": self.proxy_url, "https": self.proxy_url}
            )
        )
