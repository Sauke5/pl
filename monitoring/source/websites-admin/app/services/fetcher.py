from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import ssl
from dataclasses import dataclass
from typing import Iterable
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpcore
import httpx
from httpcore._backends.auto import AutoBackend
from httpcore._backends.base import SOCKET_OPTION

from app.config import Settings

logger = logging.getLogger(__name__)


class FetchError(RuntimeError):
    pass


class SSRFBlockedError(FetchError):
    pass


class ResponseTooLargeError(FetchError):
    pass


@dataclass(frozen=True, slots=True)
class FetchResult:
    requested_url: str
    final_url: str
    status_code: int
    content_type: str
    body: bytes
    text: str
    redirects: tuple[str, ...]


def _allowed_by_allowlist(host: str, address: ipaddress.IPv4Address | ipaddress.IPv6Address, allowlist: Iterable[str]) -> bool:
    for value in allowlist:
        if value.casefold() == host.casefold():
            return True
        try:
            if address in ipaddress.ip_network(value, strict=False):
                return True
        except ValueError:
            continue
    return False


def validate_ip(host: str, raw_address: str, allowlist: Iterable[str]) -> str:
    try:
        address = ipaddress.ip_address(raw_address)
    except ValueError as exc:
        raise SSRFBlockedError("DNS вернул некорректный IP-адрес.") from exc
    if _allowed_by_allowlist(host, address, allowlist):
        return str(address)
    if (
        address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_unspecified
        or address.is_private
        or address.is_reserved
    ):
        raise SSRFBlockedError("URL ведёт во внутреннюю или служебную сеть; запрос заблокирован.")
    return str(address)


def validate_url(url: str) -> tuple[str, int]:
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise SSRFBlockedError("Некорректный URL.") from exc
    if parsed.scheme not in {"http", "https"}:
        raise SSRFBlockedError("Разрешены только http и https URL.")
    if not parsed.hostname:
        raise SSRFBlockedError("В URL отсутствует имя хоста.")
    if parsed.username is not None or parsed.password is not None:
        raise SSRFBlockedError("Credentials в URL запрещены.")
    effective_port = port or (443 if parsed.scheme == "https" else 80)
    if effective_port not in {80, 443}:
        raise SSRFBlockedError("Разрешены только порты 80 и 443.")
    return parsed.hostname.rstrip("."), effective_port


async def resolve_public(host: str, port: int, allowlist: Iterable[str]) -> tuple[str, ...]:
    try:
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError("DNS-имя не разрешается.") from exc
    addresses: list[str] = []
    for _family, _type, _proto, _canonname, sockaddr in records:
        address = validate_ip(host, sockaddr[0], allowlist)
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise FetchError("DNS не вернул адресов.")
    return tuple(addresses)


class PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connects an already validated hostname to one of its pre-resolved IPs.

    TLS still receives the original hostname from httpcore, so certificate/SNI
    verification remains correct while a second DNS lookup cannot rebind the
    connection to a private address.
    """

    def __init__(self, expected_host: str, addresses: tuple[str, ...]):
        self.expected_host = expected_host.casefold()
        self.addresses = addresses
        self.backend = AutoBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Iterable[SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        if host.rstrip(".").casefold() != self.expected_host:
            raise SSRFBlockedError("Сетевая библиотека попыталась подключиться к непроверенному хосту.")
        last_error: Exception | None = None
        for address in self.addresses:
            try:
                return await self.backend.connect_tcp(address, port, timeout, local_address, socket_options)
            except Exception as exc:  # pragma: no cover - depends on live network ordering
                last_error = exc
        if last_error:
            raise last_error
        raise httpcore.ConnectError("No validated address available")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Iterable[SOCKET_OPTION] | None = None,
    ) -> httpcore.AsyncNetworkStream:
        raise SSRFBlockedError("Unix sockets запрещены.")

    async def sleep(self, seconds: float) -> None:
        await self.backend.sleep(seconds)


def _pinned_transport(host: str, addresses: tuple[str, ...]) -> httpx.AsyncHTTPTransport:
    transport = httpx.AsyncHTTPTransport(verify=True, trust_env=False, http1=True, http2=False, retries=0)
    ssl_context = transport._pool._ssl_context  # type: ignore[attr-defined]
    transport._pool = httpcore.AsyncConnectionPool(  # type: ignore[attr-defined]
        ssl_context=ssl_context,
        max_connections=1,
        max_keepalive_connections=0,
        http1=True,
        http2=False,
        retries=0,
        network_backend=PinnedNetworkBackend(host, addresses),
    )
    return transport


class SafeFetcher:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def fetch(self, url: str) -> FetchResult:
        requested_url = url.strip()
        current = requested_url
        redirects: list[str] = []
        timeout = httpx.Timeout(
            connect=self.settings.fetch_connect_timeout,
            read=self.settings.fetch_read_timeout,
            write=self.settings.fetch_read_timeout,
            pool=self.settings.fetch_connect_timeout,
        )
        for redirect_index in range(self.settings.fetch_max_redirects + 1):
            host, port = validate_url(current)
            addresses = await resolve_public(host, port, self.settings.ssrf_allowlist)
            transport = _pinned_transport(host, addresses)
            try:
                async with httpx.AsyncClient(
                    transport=transport,
                    timeout=timeout,
                    follow_redirects=False,
                    trust_env=False,
                    headers={
                        "User-Agent": "PL-Websites-Admin/1.0",
                        "Accept": "text/html,application/xhtml+xml;q=0.9",
                    },
                ) as client:
                    async with client.stream("GET", current) as response:
                        if response.status_code in {301, 302, 303, 307, 308}:
                            location = response.headers.get("location")
                            if not location:
                                raise FetchError("Сайт вернул redirect без заголовка Location.")
                            if redirect_index >= self.settings.fetch_max_redirects:
                                raise FetchError("Превышен лимит перенаправлений.")
                            next_url = urljoin(current, location)
                            validate_url(next_url)
                            redirects.append(next_url)
                            current = next_url
                            continue

                        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                        if content_type not in {"text/html", "application/xhtml+xml"}:
                            raise FetchError("Сайт вернул неподдерживаемый Content-Type; нужен HTML.")
                        declared_length = response.headers.get("content-length")
                        if declared_length and declared_length.isdigit() and int(declared_length) > self.settings.max_response_bytes:
                            raise ResponseTooLargeError("HTML превышает допустимый размер.")
                        body = bytearray()
                        async for chunk in response.aiter_bytes():
                            body.extend(chunk)
                            if len(body) > self.settings.max_response_bytes:
                                raise ResponseTooLargeError("HTML превышает допустимый размер.")
                        encoding = response.encoding or "utf-8"
                        try:
                            text = bytes(body).decode(encoding, errors="replace")
                        except LookupError:
                            text = bytes(body).decode("utf-8", errors="replace")
                        return FetchResult(
                            requested_url=requested_url,
                            final_url=str(response.url),
                            status_code=response.status_code,
                            content_type=content_type,
                            body=bytes(body),
                            text=text,
                            redirects=tuple(redirects),
                        )
            except SSRFBlockedError:
                raise
            except (httpx.TimeoutException, httpcore.TimeoutException) as exc:
                raise FetchError("Сайт не ответил за отведённое время.") from exc
            except ssl.SSLError as exc:
                raise FetchError("Ошибка проверки TLS-сертификата сайта.") from exc
            except httpx.HTTPError as exc:
                logger.info("website_fetch_failed", extra={"url": current, "error_type": type(exc).__name__})
                raise FetchError(f"Не удалось загрузить сайт: {type(exc).__name__}.") from exc
        raise FetchError("Превышен лимит перенаправлений.")
