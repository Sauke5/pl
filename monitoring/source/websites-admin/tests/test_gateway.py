from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import hmac
import json
from pathlib import Path
from threading import Barrier

import httpx
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from starlette.responses import Response

from app.auth.gateway import GatewayError, GatewayMiddleware, GatewayVerifier, MAX_BODY, read_key
from app.auth.service import AuthService
from app.database import Base
from app.models import ServerSession


# Public, test-only key from the shared Go/Python wire specification.
KEY = b"0123456789abcdef0123456789abcdef"
NOW = 1790000000


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def signed_request(*, method="POST", uri="/websites/preview?q=a%2Fb&q=c", body=b"reason=a%2Bb&csrf_token=test", changes=None):
    claims = dict(v=1, aud="websites-admin", iat=NOW, exp=NOW + 30,
                  nonce=b64(bytes(range(32))), sub="ad:test-user", name="Тестовый пользователь",
                  admin=True, scopes=["websites:read", "websites:write"], method=method,
                  uri=uri, content_type="application/x-www-form-urlencoded" if body else "",
                  body_sha256=hashlib.sha256(body).hexdigest(), idempotency_key="test-operation",
                  source_ip="192.0.2.10", csrf_token=b64(bytes(range(32))),
                  csrf_verified=method not in {"GET", "HEAD"})
    claims.update(changes or {})
    encoded = b64(json.dumps(claims, ensure_ascii=False, separators=(",", ":")).encode())
    headers = [(b"x-pl-gateway-assertion", encoded.encode()),
               (b"x-pl-gateway-signature", b64(hmac.digest(KEY, b"pl-gateway-v1\n" + encoded.encode(), "sha256")).encode()),
               (b"content-type", claims["content_type"].encode()),
               (b"idempotency-key", str(claims["idempotency_key"]).encode()),
               (b"x-csrf-token", str(claims["csrf_token"]).encode())]
    path, _, query = uri.partition("?")
    scope = dict(type="http", method=method, path=path, raw_path=path.encode(), query_string=query.encode(), headers=headers)
    return scope, body


def test_cross_language_signature_vector_and_audience_separation():
    # The literal published assertion is also checked by the core Go signer test.
    contract = Path(__file__).resolve().parents[2] / "it-portal/docs/platform-sso-contract.md"
    vector = json.loads(contract.read_text().rsplit("```json\n", 1)[1].split("```", 1)[0])
    encoded, signature = vector["assertion"], vector["signature"]
    assert signature == "TUhJ6q8-O85ImARF0JqL6ZfwHdqCK8DW1mpGKwbAsWU"
    assert b64(hmac.digest(KEY, b"pl-gateway-v1\n" + encoded.encode(), "sha256")) == signature
    scope, body = signed_request()
    scope["headers"][:2] = [(b"x-pl-gateway-assertion", encoded.encode()), (b"x-pl-gateway-signature", signature.encode())]
    with pytest.raises(GatewayError, match="прав"):
        GatewayVerifier(KEY).verify(scope, body, NOW)


@pytest.mark.parametrize("length", [16, 32, 64])
def test_valid_websites_assertion_nonce_sizes(length):
    scope, body = signed_request(changes={"nonce": b64(bytes(range(length)))})
    identity = GatewayVerifier(KEY).verify(scope, body, NOW)
    assert identity.subject == "ad:test-user"
    assert identity.name == "Тестовый пользователь"


@pytest.mark.parametrize("changes", [
    {"admin": False}, {"admin": 1}, {"v": True}, {"v": 2}, {"aud": "monitoring-admin"},
    {"scopes": ["websites:read"]}, {"scopes": ["websites:write", "websites:read"]},
    {"scopes": ["websites:read", "websites:read", "websites:write"]},
    {"iat": NOW + 6}, {"exp": NOW - 6, "iat": NOW - 30}, {"exp": NOW + 31},
    {"iat": True}, {"csrf_verified": False}, {"csrf_verified": 1}, {"sub": ""},
    {"name": "bad\nname"}, {"source_ip": "not-an-ip"},
    {"nonce": b64(bytes(15))}, {"nonce": b64(bytes(65))},
])
def test_rejects_invalid_claims(changes):
    scope, body = signed_request(changes=changes)
    with pytest.raises(GatewayError):
        GatewayVerifier(KEY).verify(scope, body, NOW)


@pytest.mark.parametrize("mutation", ["method", "path", "query", "body", "content-type", "idempotency-key", "x-csrf-token", "signature"])
def test_rejects_request_mutation(mutation):
    scope, body = signed_request()
    if mutation == "method":
        scope["method"] = "GET"
    elif mutation == "path":
        scope["raw_path"] = b"/websites/other"
    elif mutation == "query":
        scope["query_string"] = b"q=a/b&q=c"
    elif mutation == "body":
        body += b"&extra=1"
    else:
        header = b"x-pl-gateway-signature" if mutation == "signature" else mutation.encode()
        scope["headers"] = [(k, b"A" * 43 if mutation == "signature" else b"changed") if k == header else (k, v) for k, v in scope["headers"]]
    with pytest.raises(GatewayError):
        GatewayVerifier(KEY).verify(scope, body, NOW)


@pytest.mark.parametrize("header", [b"x-pl-gateway-assertion", b"x-pl-gateway-signature", b"content-type", b"idempotency-key", b"x-csrf-token"])
def test_rejects_duplicate_headers(header):
    scope, body = signed_request()
    scope["headers"].append(next((k.upper(), v) for k, v in scope["headers"] if k == header))
    with pytest.raises(GatewayError, match="заголовок"):
        GatewayVerifier(KEY).verify(scope, body, NOW)


def test_rejects_duplicate_json_fields_even_with_valid_signature():
    scope, body = signed_request()
    raw = base64.urlsafe_b64decode(scope["headers"][0][1] + b"==")
    encoded = b64(raw[:-1] + b',"admin":true}')
    scope["headers"][:2] = [(b"x-pl-gateway-assertion", encoded.encode()), (b"x-pl-gateway-signature", b64(hmac.digest(KEY, b"pl-gateway-v1\n" + encoded.encode(), "sha256")).encode())]
    with pytest.raises(GatewayError, match="Повторяющееся поле"):
        GatewayVerifier(KEY).verify(scope, body, NOW)


@pytest.mark.parametrize("field", ["v", "aud", "iat", "exp", "nonce", "sub", "name", "admin", "scopes", "method", "uri", "content_type", "body_sha256", "idempotency_key", "source_ip", "csrf_token", "csrf_verified"])
def test_rejects_each_missing_required_claim(field):
    scope, body = signed_request()
    claims = json.loads(base64.urlsafe_b64decode(scope["headers"][0][1] + b"=="))
    del claims[field]
    encoded = b64(json.dumps(claims, separators=(",", ":")).encode())
    scope["headers"][:2] = [(b"x-pl-gateway-assertion", encoded.encode()), (b"x-pl-gateway-signature", b64(hmac.digest(KEY, b"pl-gateway-v1\n" + encoded.encode(), "sha256")).encode())]
    with pytest.raises(GatewayError, match="Неполное"):
        GatewayVerifier(KEY).verify(scope, body, NOW)


def test_wrong_service_key_rejects_valid_assertion():
    scope, body = signed_request()
    with pytest.raises(GatewayError):
        GatewayVerifier(bytes(32)).verify(scope, body, NOW)


def test_escaped_path_is_compared_as_wire_bytes_not_decoded_path():
    scope, body = signed_request(method="GET", uri="/websites/targets/a%2Fb?q=x%20y&q=x+y", body=b"")
    scope["path"] = "/websites/targets/a/b"
    assert GatewayVerifier(KEY).verify(scope, body, NOW).subject == "ad:test-user"
    scope["raw_path"] = b"/websites/targets/a/b"
    with pytest.raises(GatewayError):
        GatewayVerifier(KEY).verify(scope, body, NOW)


def test_concurrent_unsafe_replay_has_exactly_one_winner():
    verifier = GatewayVerifier(KEY)
    scope, body = signed_request()
    barrier = Barrier(8)
    def attempt(_):
        barrier.wait()
        try:
            verifier.verify(scope, body, NOW)
            return 200
        except GatewayError as exc:
            return exc.status
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, range(8)))
    assert results.count(200) == 1
    assert results.count(409) == 7


def test_safe_read_scope_allows_repeated_assertion():
    scope, body = signed_request(method="GET", body=b"", changes={"scopes": ["websites:read"]})
    verifier = GatewayVerifier(KEY)
    assert verifier.verify(scope, body, NOW) == verifier.verify(scope, body, NOW)


@pytest.mark.parametrize("key", [b"", KEY.hex().encode(), base64.b64encode(KEY), KEY + b"\n"])
def test_key_file_rejects_non_raw_32_bytes(tmp_path, key):
    path = tmp_path / "key"
    path.write_bytes(key)
    with pytest.raises(ValueError):
        read_key(path)


def test_key_file_preserves_whitespace_bytes(tmp_path):
    path = tmp_path / "key"
    raw = b"\n" + bytes(range(30)) + b" "
    path.write_bytes(raw)
    assert read_key(path) == raw


def test_gateway_identity_is_stable_without_local_sessions_and_cookie_fallback(settings, tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'identity.db'}")
    Base.metadata.create_all(engine)
    gateway = AuthService(replace(settings, auth_mode="gateway"))
    with Session(engine, expire_on_commit=False) as db:
        standalone = AuthService(settings)
        local = standalone.create_user(db, "operator", "test-password-long-enough")
        token = standalone.create_session(db, local, "192.0.2.10", Response())
        scope, body = signed_request()
        scope["headers"].append((b"cookie", f"{settings.session_cookie}={token}".encode()))
        assert gateway.get_context(db, Request(scope)) is None
        db.query(ServerSession).delete()
        db.commit()
        identity = GatewayVerifier(KEY).verify(scope, body, NOW)
        scope["state"] = {"gateway_identity": identity}
        first = gateway.get_context(db, Request(scope))
        scope["state"]["gateway_identity"] = replace(identity, name="Renamed")
        again = gateway.get_context(db, Request(scope))
        scope["state"]["gateway_identity"] = replace(identity, subject="ad:another-user")
        other = gateway.get_context(db, Request(scope))
        assert first.user.id == again.user.id != other.user.id
        assert again.display_name == "Renamed"
        assert first.user.id != local.id
        assert first.user.password_hash == "!platform-only"
        assert db.scalars(select(ServerSession)).all() == []
    engine.dispose()


@pytest.mark.asyncio
async def test_prefixed_asgi_request_preserves_exact_body_for_form_handler(monkeypatch):
    monkeypatch.setattr("app.auth.gateway.time.time", lambda: NOW)
    app = FastAPI(root_path="/websites")
    app.add_middleware(GatewayMiddleware, verifier=GatewayVerifier(KEY))
    @app.post("/preview")
    async def preview(request: Request):
        raw = await request.body()
        form = await request.form()
        return {"raw": raw.decode(), "reason": form["reason"], "subject": request.state.gateway_identity.subject}
    scope, body = signed_request()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://testserver") as client:
        response = await client.post("/websites/preview?q=a%2Fb&q=c", content=body, headers=scope["headers"])
        assert response.status_code == 200, response.text
        assert response.json() == {"raw": body.decode(), "reason": "a+b", "subject": "ad:test-user"}
        unsigned = await client.post("/websites/preview", content=body, headers={"Cookie": "session=local"})
        assert unsigned.status_code == 401
        oversized = await client.post("/websites/preview", content=b"x" * (MAX_BODY + 1))
        assert oversized.status_code == 413


def test_positive_published_websites_vector_from_core_go():
    """Verify the published Go-signed form request without re-signing in Python."""
    fixture_path = Path(__file__).resolve().parents[2] / 'it-portal/docs/examples/admin-v1-vectors.json'
    fixture = json.loads(fixture_path.read_text())
    assert fixture['schema'] == 1
    assert fixture['key_raw_ascii'].encode() == KEY
    vector = next(item for item in fixture['cases'] if item['claims']['aud'] == 'websites-admin')
    c = vector['claims']
    path, _, query = c['uri'].partition('?')
    request = dict(type='http', path=path, method=c['method'], raw_path=path.encode(), query_string=query.encode(), headers=[
        (b'x-pl-gateway-assertion', vector['assertion'].encode()),
        (b'x-pl-gateway-signature', vector['signature'].encode()),
        (b'content-type', c['content_type'].encode()),
        (b'idempotency-key', c['idempotency_key'].encode()),
        (b'x-csrf-token', c['csrf_token'].encode()),
    ])
    identity = GatewayVerifier(KEY).verify(request, vector['body_utf8'].encode(), c['iat'])
    assert identity.subject == c['sub']
    assert identity.csrf_token == vector['expected_service_csrf']
