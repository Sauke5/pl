from __future__ import annotations

import asyncio
import socket

import httpx
import pytest

from app.services import fetcher as fetcher_module
from app.services.fetcher import (
    FetchError,
    PinnedNetworkBackend,
    ResponseTooLargeError,
    SSRFBlockedError,
    SafeFetcher,
    resolve_public,
    validate_ip,
    validate_url,
)


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "ftp://example.org/a", "http://user:pass@example.org/", "https://example.org:8443/"],
)
def test_disallowed_urls_are_rejected(url):
    with pytest.raises(SSRFBlockedError):
        validate_url(url)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fc00::1"])
def test_private_and_metadata_addresses_are_blocked(address):
    with pytest.raises(SSRFBlockedError):
        validate_ip("example.org", address, ())


def test_explicit_allowlist_can_enable_internal_target():
    assert validate_ip("internal.example.test", "10.20.30.40", ("internal.example.test",)) == "10.20.30.40"


@pytest.mark.asyncio
async def test_dns_resolution_rejects_mixed_public_private_answers(monkeypatch):
    async def fake_getaddrinfo(*_args, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.9", 443)),
        ]

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", fake_getaddrinfo)
    with pytest.raises(SSRFBlockedError):
        await resolve_public("example.org", 443, ())


@pytest.mark.asyncio
async def test_dns_failure_is_reported_without_resolver_details(monkeypatch):
    async def failing_getaddrinfo(*_args, **_kwargs):
        raise socket.gaierror("internal resolver detail")

    monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", failing_getaddrinfo)
    with pytest.raises(FetchError, match="DNS-имя не разрешается"):
        await resolve_public("missing.example.org", 443, ())


@pytest.mark.asyncio
async def test_pinned_backend_uses_validated_ip_without_second_dns_lookup():
    backend = PinnedNetworkBackend("example.org", ("93.184.216.34",))
    calls = []

    class FakeBackend:
        async def connect_tcp(self, host, port, timeout, local_address, socket_options):
            calls.append((host, port))
            return object()

        async def sleep(self, _seconds):
            return None

    backend.backend = FakeBackend()
    await backend.connect_tcp("example.org", 443)
    assert calls == [("93.184.216.34", 443)]
    with pytest.raises(SSRFBlockedError):
        await backend.connect_tcp("rebound.example.org", 443)


@pytest.mark.asyncio
async def test_fetcher_follows_redirect_and_keeps_requested_url(settings, monkeypatch):
    async def public(_host, _port, _allowlist):
        return ("93.184.216.34",)

    async def handler(request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "https://example.org/final"})
        return httpx.Response(200, headers={"content-type": "text/html"}, text="<html>готовая страница</html>")

    monkeypatch.setattr(fetcher_module, "resolve_public", public)
    monkeypatch.setattr(fetcher_module, "_pinned_transport", lambda *_args: httpx.MockTransport(handler))
    result = await SafeFetcher(settings).fetch("https://example.org/start")
    assert result.requested_url == "https://example.org/start"
    assert result.final_url == "https://example.org/final"
    assert result.redirects == ("https://example.org/final",)


@pytest.mark.asyncio
async def test_redirect_to_private_ip_is_rechecked_and_blocked(settings, monkeypatch):
    async def resolution(host, _port, _allowlist):
        if host == "127.0.0.1":
            raise SSRFBlockedError("private redirect")
        return ("93.184.216.34",)

    monkeypatch.setattr(fetcher_module, "resolve_public", resolution)
    monkeypatch.setattr(
        fetcher_module,
        "_pinned_transport",
        lambda *_args: httpx.MockTransport(
            lambda _request: httpx.Response(302, headers={"location": "http://127.0.0.1/metadata"})
        ),
    )
    with pytest.raises(SSRFBlockedError):
        await SafeFetcher(settings).fetch("https://example.org/")


@pytest.mark.asyncio
async def test_fetcher_enforces_streaming_size_limit(settings, monkeypatch):
    async def public(*_args):
        return ("93.184.216.34",)

    monkeypatch.setattr(fetcher_module, "resolve_public", public)
    monkeypatch.setattr(
        fetcher_module,
        "_pinned_transport",
        lambda *_args: httpx.MockTransport(
            lambda _request: httpx.Response(200, headers={"content-type": "text/html"}, content=b"x" * 1025)
        ),
    )
    with pytest.raises(ResponseTooLargeError):
        await SafeFetcher(settings).fetch("https://example.org/")


@pytest.mark.asyncio
async def test_fetcher_converts_timeout_to_safe_error(settings, monkeypatch):
    async def public(*_args):
        return ("93.184.216.34",)

    def timeout(_request):
        raise httpx.ReadTimeout("secret upstream detail")

    monkeypatch.setattr(fetcher_module, "resolve_public", public)
    monkeypatch.setattr(fetcher_module, "_pinned_transport", lambda *_args: httpx.MockTransport(timeout))
    with pytest.raises(FetchError, match="не ответил"):
        await SafeFetcher(settings).fetch("https://example.org/")
