"""PL gateway v1 verification. One process/replica; no local auth fallback."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import threading
import time
from pathlib import Path

from starlette.responses import JSONResponse

from app.auth.providers import Principal
from app.auth.service import AuthContext

SAFE = {"GET", "HEAD"}
SCOPES = {"monitoring:read", "containers:restart", "audit:read"}
FIELDS = {"v", "aud", "iat", "exp", "nonce", "sub", "name", "admin", "scopes", "method", "uri",
          "content_type", "body_sha256", "idempotency_key", "source_ip", "csrf_token", "csrf_verified"}


class GatewayError(Exception):
    def __init__(self, code: str, status: int = 401):
        self.code, self.status = code, status


def decode(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise GatewayError("invalid_gateway_encoding")
    try:
        result = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except ValueError as exc:
        raise GatewayError("invalid_gateway_encoding") from exc
    if base64.urlsafe_b64encode(result).decode().rstrip("=") != value:
        raise GatewayError("invalid_gateway_encoding")
    return result


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GatewayError("duplicate_gateway_claim")
        result[key] = value
    return result


class GatewayVerifier:
    def __init__(self, key_file: Path):
        self.key_file = key_file
        self.key = b""
        self.nonces: dict[str, int] = {}
        self.lock = threading.Lock()

    def validate_configuration(self):
        try:
            self.key = self.key_file.read_bytes()
        except OSError as exc:
            raise RuntimeError("Gateway key cannot be read") from exc
        if len(self.key) != 32:
            raise RuntimeError("Gateway key must contain exactly 32 raw bytes")

    def verify(self, scope, body: bytes, now: float | None = None):
        now = time.time() if now is None else now
        headers: dict[str, str] = {}
        protected = {"x-pl-gateway-assertion", "x-pl-gateway-signature", "content-type", "idempotency-key", "x-csrf-token", "content-encoding"}
        for key, value in scope["headers"]:
            name = key.decode("latin1").lower()
            if name in protected:
                if name in headers:
                    raise GatewayError("duplicate_gateway_header")
                headers[name] = value.decode("latin1")
        assertion = headers.get("x-pl-gateway-assertion", "")
        if not self.key or len(assertion) > 8192:
            raise GatewayError("invalid_gateway_assertion")
        signature = decode(headers.get("x-pl-gateway-signature", ""))
        expected = hmac.digest(self.key, b"pl-gateway-v1\n" + assertion.encode("ascii", errors="replace"), "sha256")
        if not hmac.compare_digest(signature, expected):
            raise GatewayError("invalid_gateway_signature")
        try:
            claims = json.loads(decode(assertion), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError) as exc:
            raise GatewayError("invalid_gateway_json") from exc
        if not isinstance(claims, dict) or not FIELDS.issubset(claims):
            raise GatewayError("missing_gateway_claim")
        for key in FIELDS - {"v", "iat", "exp", "admin", "scopes", "csrf_verified"}:
            value = claims[key]
            if not isinstance(value, str) or any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise GatewayError("invalid_gateway_claim")
        if (type(claims["v"]) is not int or claims["v"] != 1 or claims["aud"] != "monitoring-admin"
                or claims["admin"] is not True or type(claims["csrf_verified"]) is not bool
                or type(claims["iat"]) is not int or type(claims["exp"]) is not int):
            raise GatewayError("invalid_gateway_claim")
        if not (0 < claims["exp"] - claims["iat"] <= 30 and claims["iat"] <= now + 5 and claims["exp"] >= now - 5):
            raise GatewayError("expired_gateway_assertion")
        scopes = claims["scopes"]
        if not isinstance(scopes, list) or any(not isinstance(s, str) or s not in SCOPES for s in scopes) or scopes != sorted(set(scopes)):
            raise GatewayError("invalid_gateway_scopes")
        try:
            limits = {"sub": 256, "name": 512, "uri": 4096, "idempotency_key": 128}
            if any(len(claims[k].encode("ascii" if k == "uri" else "utf-8")) > limit for k, limit in limits.items()):
                raise ValueError
            if not claims["sub"] or not claims["name"] or not 16 <= len(decode(claims["nonce"])) <= 64:
                raise ValueError
            ipaddress.ip_address(claims["source_ip"])
            if len(decode(claims["csrf_token"])) != 32:
                raise ValueError
        except (ValueError, UnicodeError) as exc:
            raise GatewayError("invalid_gateway_claim") from exc
        uri = scope["raw_path"] + (b"?" + scope["query_string"] if scope["query_string"] else b"")
        if (claims["method"] != scope["method"] or claims["uri"].encode("ascii") != uri
                or claims["content_type"] != headers.get("content-type", "")
                or claims["idempotency_key"] != headers.get("idempotency-key", "")
                or claims["body_sha256"] != hashlib.sha256(body).hexdigest()
                or headers.get("content-encoding", "") not in {"", "identity"}):
            raise GatewayError("gateway_request_mismatch")
        if scope["method"] in SAFE:
            if claims["csrf_verified"]:
                raise GatewayError("invalid_gateway_csrf", 403)
        else:
            if not claims["csrf_verified"] or not hmac.compare_digest(headers.get("x-csrf-token", "").encode("latin1"), claims["csrf_token"].encode("ascii")):
                raise GatewayError("invalid_gateway_csrf", 403)
            if scope["raw_path"].endswith(b"/restart") and not claims["idempotency_key"]:
                raise GatewayError("gateway_idempotency_required", 400)
            with self.lock:
                self.nonces = {key: exp for key, exp in self.nonces.items() if exp >= now}
                if claims["nonce"] in self.nonces:
                    raise GatewayError("gateway_replay", 409)
                if len(self.nonces) >= 10000:
                    raise GatewayError("gateway_replay_cache_full", 503)
                self.nonces[claims["nonce"]] = claims["exp"] + 5
        return claims


class GatewayMiddleware:
    def __init__(self, app, verifier: GatewayVerifier):
        self.app, self.verifier = app, verifier

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        root = scope.get("root_path", "").rstrip("/")
        if scope["path"] in {"/health", root + "/health"} and scope["method"] in SAFE:
            await self.app(scope, receive, send)
            return
        try:
            body = bytearray()
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                body.extend(message.get("body", b""))
                if len(body) > 2 * 1024 * 1024:
                    raise GatewayError("request_body_too_large", 413)
                if not message.get("more_body", False):
                    break
            claims = self.verifier.verify(scope, bytes(body))
        except GatewayError as exc:
            await JSONResponse({"detail": exc.code}, status_code=exc.status)(scope, receive, send)
            return
        state = scope.setdefault("state", {})
        state["gateway_claims"] = claims
        state["gateway_context"] = AuthContext(Principal("gateway", claims["sub"], claims["name"], frozenset(claims["scopes"])), None, claims["csrf_token"])
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)
