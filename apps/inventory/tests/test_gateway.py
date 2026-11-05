import base64
import copy
import hashlib
import hmac
import json
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor

from inventory_service.gateway import GatewayError, GatewayVerifier

KEY = b"0123456789abcdef0123456789abcdef"
NOW = 1793280000


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def signed_request(method="GET", uri="/inventory/api/data", body=b"", content_type="", actor="ad:employee", now=None, nonce=None, admin=False, key=KEY, idempotency_key=""):
    now = int(time.time()) if now is None else now
    path, _, query = uri.partition("?")
    csrf = b64(b"x" * 32)
    claims = dict(v=2, aud="inventory", iat=now, exp=now + 30, nonce=nonce or b64(uuid.uuid4().bytes), sub=actor, name="Иван Пользователь", admin=admin, scopes=["inventory:read" if method in {"GET", "HEAD"} else "inventory:write"], method=method, uri=uri, content_type=content_type, body_sha256=hashlib.sha256(body).hexdigest(), idempotency_key=idempotency_key, source_ip="192.0.2.20", csrf_token=csrf, csrf_verified=method not in {"GET", "HEAD"})
    assertion = b64(json.dumps(claims, ensure_ascii=False, separators=(",", ":")).encode())
    header = [(b"x-pl-gateway-assertion", assertion.encode()), (b"x-pl-gateway-signature", b64(hmac.digest(key, b"pl-gateway-v2\n" + assertion.encode(), "sha256")).encode())]
    if content_type:
        header.append((b"content-type", content_type.encode()))
    if idempotency_key:
        header.append((b"idempotency-key", idempotency_key.encode()))
    if method not in {"GET", "HEAD"}:
        header.append((b"x-csrf-token", csrf.encode()))
    scope = dict(type="http", asgi={"version": "3.0"}, method=method, path=path, raw_path=path.encode(), query_string=query.encode(), headers=header, client=("127.0.0.1", 40000), scheme="http", server=("localhost", 8768))
    return scope, claims


def resign(scope, claims):
    scope = copy.deepcopy(scope)
    assertion = b64(json.dumps(claims, ensure_ascii=False, separators=(",", ":")).encode())
    scope["headers"] = [(k, v) for k, v in scope["headers"] if k not in {b"x-pl-gateway-assertion", b"x-pl-gateway-signature"}]
    scope["headers"] += [(b"x-pl-gateway-assertion", assertion.encode()), (b"x-pl-gateway-signature", b64(hmac.digest(KEY, b"pl-gateway-v2\n" + assertion.encode(), "sha256")).encode())]
    return scope


class GatewayTests(unittest.TestCase):
    def test_employee_and_admin_have_identical_read_write_access(self):
        for admin in (False, True):
            for method, body in (("GET", b""), ("POST", b"{}")):
                scope, _ = signed_request(method, body=body, now=NOW, admin=admin)
                scope_name = "inventory:read" if method == "GET" else "inventory:write"
                self.assertEqual(GatewayVerifier(KEY).verify(scope, body, NOW, scope_name)["admin"], admin)

    def test_anon_forgery_and_other_key_rejected(self):
        scope, _ = signed_request(now=NOW)
        for candidate in ({**scope, "headers": []}, signed_request(now=NOW, key=b"z" * 32)[0]):
            with self.assertRaises(GatewayError):
                GatewayVerifier(KEY).verify(candidate, b"", NOW)

    def test_binding_body_uri_content_type_and_csrf(self):
        scope, _ = signed_request("POST", "/inventory/api/imports/preview?a=1", b"payload", "multipart/form-data; boundary=x", now=NOW)
        for field, value in (("method", "GET"), ("raw_path", b"/inventory/api/data"), ("query_string", b"a=2")):
            altered = copy.deepcopy(scope)
            altered[field] = value
            with self.assertRaises(GatewayError):
                GatewayVerifier(KEY).verify(altered, b"payload", NOW, "inventory:write")
        with self.assertRaises(GatewayError):
            GatewayVerifier(KEY).verify(scope, b"changed", NOW, "inventory:write")
        for name in (b"content-type", b"x-csrf-token"):
            altered = copy.deepcopy(scope)
            altered["headers"] = [(k, b"bad" if k == name else v) for k, v in altered["headers"]]
            with self.assertRaises(GatewayError):
                GatewayVerifier(KEY).verify(altered, b"payload", NOW, "inventory:write")

    def test_invalid_claims_and_scope(self):
        scope, claims = signed_request(now=NOW)
        for key, value in (("v", 1), ("aud", "forms"), ("sub", ""), ("admin", 1), ("iat", NOW + 6), ("exp", NOW - 6), ("scopes", ["inventory:write"]), ("name", "bad\nname")):
            with self.subTest(key=key), self.assertRaises(GatewayError):
                GatewayVerifier(KEY).verify(resign(scope, {**claims, key: value}), b"", NOW)
        with self.assertRaises(GatewayError):
            GatewayVerifier(KEY).verify(resign(scope, {**claims, "scopes": ["inventory:read", "inventory:write"]}), b"", NOW)

    def test_duplicate_headers_and_replay(self):
        scope, _ = signed_request("POST", body=b"{}", now=NOW)
        duplicated = copy.deepcopy(scope)
        duplicated["headers"].append(duplicated["headers"][0])
        with self.assertRaises(GatewayError):
            GatewayVerifier(KEY).verify(duplicated, b"{}", NOW, "inventory:write")
        verifier = GatewayVerifier(KEY)
        def once(_):
            try:
                verifier.verify(scope, b"{}", NOW, "inventory:write")
                return 200
            except GatewayError as exc:
                return exc.status
        with ThreadPoolExecutor(max_workers=8) as pool:
            result = list(pool.map(once, range(16)))
        self.assertEqual(result.count(200), 1)
        self.assertEqual(result.count(409), 15)


if __name__ == "__main__":
    unittest.main()
