"""PL gateway v1: request-bound identity, never a secondary login session."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from starlette.responses import JSONResponse

AUDIENCE = "websites-admin"
MAX_BODY = 2 * 1024 * 1024
SAFE_METHODS = {"GET", "HEAD"}


class GatewayError(ValueError):
    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.status = status


def read_key(path: Path | None) -> bytes:
    if path is None:
        raise ValueError("Gateway auth requires WEBSITES_ADMIN_PLATFORM_SSO_KEY_FILE")
    raw = path.read_bytes()
    if len(raw) != 32:
        raise ValueError("Gateway key must contain exactly 32 raw bytes")
    return raw


def _decode(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise GatewayError("Недопустимое подтверждение входа.")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value:
        raise GatewayError("Недопустимое подтверждение входа.")
    return decoded


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GatewayError("Повторяющееся поле подтверждения входа.")
        result[key] = value
    return result


@dataclass(frozen=True, slots=True)
class GatewayIdentity:
    subject: str
    name: str
    csrf_token: str
    source_ip: str
    nonce: str
    expires: int


class GatewayVerifier:
    def __init__(self, key: bytes):
        self.key = key
        self._nonces: dict[str, int] = {}
        self._lock = threading.Lock()

    def verify(self, scope, body: bytes, now: int | None = None) -> GatewayIdentity:
        now = int(time.time()) if now is None else now
        headers: dict[str, str] = {}
        protected = {"x-pl-gateway-assertion", "x-pl-gateway-signature", "content-type", "idempotency-key", "x-csrf-token", "content-encoding"}
        for key, value in scope["headers"]:
            name = key.decode("latin1").lower()
            if name in protected:
                if name in headers:
                    raise GatewayError("Повторяющийся заголовок запроса.")
                headers[name] = value.decode("latin1")
        encoded = headers.get("x-pl-gateway-assertion", "")
        signature = headers.get("x-pl-gateway-signature", "")
        if not encoded or not signature:
            raise GatewayError("Откройте сервис через Платформу.", 401)
        if len(encoded) > 8192 or len(signature) != 43:
            raise GatewayError("Недопустимое подтверждение входа.")
        try:
            expected = hmac.digest(self.key, b"pl-gateway-v1\n" + encoded.encode("ascii"), "sha256")
            if not hmac.compare_digest(expected, _decode(signature)):
                raise GatewayError("Подтверждение входа не прошло проверку.")
            claims = json.loads(_decode(encoded), object_pairs_hook=_unique)
        except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
            if isinstance(exc, GatewayError):
                raise
            raise GatewayError("Недопустимое подтверждение входа.") from exc
        if not isinstance(claims, dict):
            raise GatewayError("Недопустимое подтверждение входа.")
        required = {"v", "aud", "iat", "exp", "nonce", "sub", "name", "admin", "scopes", "method", "uri", "content_type", "body_sha256", "idempotency_key", "source_ip", "csrf_token", "csrf_verified"}
        if not required.issubset(claims):
            raise GatewayError("Неполное подтверждение входа.")
        for field in required - {"v", "iat", "exp", "admin", "scopes", "csrf_verified"}:
            value = claims[field]
            if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise GatewayError("Недопустимые поля подтверждения входа.")
        if type(claims["v"]) is not int or claims["v"] != 1 or claims["aud"] != AUDIENCE or claims["admin"] is not True:
            raise GatewayError("Недостаточно прав Платформы.")
        if type(claims["iat"]) is not int or type(claims["exp"]) is not int:
            raise GatewayError("Недопустимое время подтверждения входа.")
        if not (0 < claims["exp"] - claims["iat"] <= 30 and claims["iat"] <= now + 5 and claims["exp"] >= now - 5):
            raise GatewayError("Подтверждение входа истекло.", 401)
        scopes = claims["scopes"]
        if not isinstance(scopes, list) or any(not isinstance(s, str) for s in scopes) or scopes != sorted(set(scopes)):
            raise GatewayError("Недопустимые права Платформы.")
        unsafe = scope["method"] not in SAFE_METHODS
        if "websites:read" not in scopes or (unsafe and "websites:write" not in scopes):
            raise GatewayError("Недостаточно прав Платформы.")
        if scope["method"] not in {"GET", "HEAD", "POST"}:
            raise GatewayError("Метод не поддерживается.", 405)
        if not claims["sub"] or len(claims["sub"].encode()) > 256 or not claims["name"] or len(claims["name"].encode()) > 512:
            raise GatewayError("Недопустимая идентичность Платформы.")
        if len(claims["uri"]) > 4096 or len(claims["idempotency_key"].encode()) > 128:
            raise GatewayError("Недопустимое подтверждение запроса.")
        try:
            uri = scope.get("raw_path", scope["path"].encode()).decode("ascii")
            query = scope.get("query_string", b"").decode("ascii")
            if query:
                uri += "?" + query
            claims["uri"].encode("ascii")
            ipaddress.ip_address(claims["source_ip"])
            if not 16 <= len(_decode(claims["nonce"])) <= 64 or len(_decode(claims["csrf_token"])) != 32:
                raise ValueError("invalid nonce or CSRF")
        except (UnicodeError, ValueError) as exc:
            raise GatewayError("Недопустимое подтверждение запроса.") from exc
        if headers.get("content-encoding", "") not in {"", "identity"}:
            raise GatewayError("Кодирование запроса не поддерживается.", 415)
        if not re.fullmatch(r"[0-9a-f]{64}", claims["body_sha256"]):
            raise GatewayError("Недопустимая контрольная сумма запроса.")
        if (claims["method"] != scope["method"] or claims["uri"] != uri
                or claims["content_type"] != headers.get("content-type", "")
                or claims["idempotency_key"] != headers.get("idempotency-key", "")
                or not hmac.compare_digest(claims["body_sha256"], hashlib.sha256(body).hexdigest())):
            raise GatewayError("Запрос изменился после авторизации.")
        if type(claims["csrf_verified"]) is not bool or claims["csrf_verified"] != unsafe:
            raise GatewayError("CSRF-проверка Платформы не пройдена.")
        if unsafe:
            # The gateway normalizes this header after validating either HTML form or API CSRF.
            if not hmac.compare_digest(headers.get("x-csrf-token", "").encode(), claims["csrf_token"].encode()):
                raise GatewayError("CSRF-проверка не пройдена.")
            with self._lock:
                self._nonces = {nonce: expiry for nonce, expiry in self._nonces.items() if expiry >= now}
                if claims["nonce"] in self._nonces:
                    raise GatewayError("Повторный запрос уже был принят.", 409)
                if len(self._nonces) >= 10000:
                    raise GatewayError("Сервис занят. Повторите позднее.", 503)
                self._nonces[claims["nonce"]] = claims["exp"] + 5
        return GatewayIdentity(claims["sub"], claims["name"], claims["csrf_token"], claims["source_ip"], claims["nonce"], claims["exp"])


class GatewayMiddleware:
    def __init__(self, app, verifier: GatewayVerifier):
        self.app = app
        self.verifier = verifier

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["path"] in {"/health", "/websites/health"}:
            await self.app(scope, receive, send)
            return
        body = bytearray()
        try:
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > MAX_BODY:
                    raise GatewayError("Запрос слишком большой.", 413)
                if not message.get("more_body", False):
                    break
            identity = self.verifier.verify(scope, bytes(body))
            scope.setdefault("state", {})["gateway_identity"] = identity
        except GatewayError as exc:
            await JSONResponse({"detail": str(exc)}, status_code=exc.status, headers={"Cache-Control": "no-store"})(scope, receive, send)
            return
        delivered = False

        async def replay_body():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay_body, send)
