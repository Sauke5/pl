"""Independent PL Forms v2 verifier; stdlib only. One process/replica."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import re
import threading
import time
import unicodedata
from pathlib import Path


SAFE = {"GET", "HEAD", "OPTIONS"}
MAX_BODY = 3 * 1024 * 1024
SCOPES = {"forms:read", "forms:admin", "forms:respond"}
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
    def __init__(self, key: bytes):
        if len(key) != 32:
            raise ValueError("Gateway key must contain exactly 32 raw bytes")
        self.key = key
        self.nonces: dict[str, int] = {}
        self.lock = threading.Lock()

    def verify(self, scope, body: bytes, now: float | None = None, required_scope: str = "forms:read"):
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
        expected = hmac.digest(self.key, b"pl-gateway-v2\n" + assertion.encode("ascii", errors="replace"), "sha256")
        if not hmac.compare_digest(signature, expected):
            raise GatewayError("invalid_gateway_signature")
        try:
            claims = json.loads(decode(assertion), object_pairs_hook=unique_object)
        except (ValueError, UnicodeError) as exc:
            raise GatewayError("invalid_gateway_json") from exc
        if not isinstance(claims, dict) or set(claims) != FIELDS:
            raise GatewayError("missing_gateway_claim")
        for key in FIELDS - {"v", "iat", "exp", "admin", "scopes", "csrf_verified"}:
            value = claims[key]
            if not isinstance(value, str) or any(unicodedata.category(c) == "Cc" for c in value):
                raise GatewayError("invalid_gateway_claim")
        if (type(claims["v"]) is not int or claims["v"] != 2 or claims["aud"] != "forms"
                or type(claims["admin"]) is not bool or type(claims["csrf_verified"]) is not bool
                or type(claims["iat"]) is not int or type(claims["exp"]) is not int):
            raise GatewayError("invalid_gateway_claim")
        if not (0 < claims["exp"] - claims["iat"] <= 30 and claims["iat"] <= now + 5 and claims["exp"] >= now - 5):
            raise GatewayError("expired_gateway_assertion")
        scopes = claims["scopes"]
        if not isinstance(scopes, list) or any(not isinstance(s, str) or s not in SCOPES for s in scopes) or scopes != sorted(set(scopes)):
            raise GatewayError("invalid_gateway_scopes")
        expected_scopes = [required_scope]
        if scopes != expected_scopes or required_scope not in SCOPES or (required_scope == "forms:admin" and not claims["admin"]):
            raise GatewayError("gateway_scope_denied", 403)
        if scope["method"] not in SAFE and required_scope not in {"forms:respond", "forms:admin"}:
            raise GatewayError("gateway_scope_denied", 403)
        if len(body) > MAX_BODY:
            raise GatewayError("request_body_too_large", 413)
        try:
            limits = {"sub": 256, "name": 512, "uri": 4096, "idempotency_key": 128, "content_type": 256}
            if any(len(claims[k].encode("ascii" if k in {"uri", "idempotency_key", "content_type"} else "utf-8")) > limit for k, limit in limits.items()):
                raise ValueError
            if not claims["sub"] or not claims["name"] or not 16 <= len(decode(claims["nonce"])) <= 64:
                raise ValueError
            ipaddress.ip_address(claims["source_ip"])
            if len(decode(claims["csrf_token"])) != 32:
                raise ValueError
        except (ValueError, UnicodeError) as exc:
            raise GatewayError("invalid_gateway_claim") from exc
        if scope["method"] not in SAFE | {"POST", "PUT", "PATCH", "DELETE"} or not scope["raw_path"].startswith(b"/forms/"):
            raise GatewayError("gateway_request_mismatch")
        uri = scope["raw_path"] + (b"?" + scope["query_string"] if scope["query_string"] else b"")
        if (claims["method"] != scope["method"] or claims["uri"].encode("ascii") != uri
                or claims["content_type"] != headers.get("content-type", "")
                or claims["idempotency_key"] != headers.get("idempotency-key", "")
                or claims["body_sha256"] != hashlib.sha256(body).hexdigest()
                or headers.get("content-encoding", "") not in {"", "identity"}):
            raise GatewayError("gateway_request_mismatch")
        if scope["method"] in SAFE:
            if body or claims["csrf_verified"]:
                raise GatewayError("invalid_gateway_csrf", 403)
        else:
            if not claims["csrf_verified"] or not hmac.compare_digest(headers.get("x-csrf-token", "").encode("latin1"), claims["csrf_token"].encode("ascii")):
                raise GatewayError("invalid_gateway_csrf", 403)
            with self.lock:
                self.nonces = {key: exp for key, exp in self.nonces.items() if exp >= now}
                if claims["nonce"] in self.nonces:
                    raise GatewayError("gateway_replay", 409)
                if len(self.nonces) >= 10000:
                    raise GatewayError("gateway_replay_cache_full", 503)
                self.nonces[claims["nonce"]] = claims["exp"] + 5
        return claims
