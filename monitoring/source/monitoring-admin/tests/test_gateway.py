from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import hmac
import json
from pathlib import Path
import time

import pytest
from fastapi.testclient import TestClient

from app.auth.gateway import GatewayError, GatewayVerifier
from app.database import Base
from app.main import create_app

KEY = b"0123456789abcdef0123456789abcdef"
CONTRACT = Path(__file__).resolve().parents[2] / "it-portal/docs/platform-sso-contract.md"
PUBLIC_VECTOR = json.loads(CONTRACT.read_text().rsplit("```json\n", 1)[1].split("```", 1)[0])
CSRF = PUBLIC_VECTOR["expected_service_csrf"]
BODY = b'{"idempotency_key":"test-restart-001"}'


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def claims(now=1790000000):
    return dict(v=1, aud="monitoring-admin", iat=now, exp=now+30,
                nonce="AAECAwQFBgcICQoLDA0ODw", sub="ad:test-user", name="Тестовый пользователь",
                admin=True, scopes=["audit:read", "containers:restart", "monitoring:read"], method="POST",
                uri="/admin/api/v1/containers/example/restart?check=a%2Fb&check=c", content_type="application/json",
                body_sha256=hashlib.sha256(BODY).hexdigest(), idempotency_key="test-restart-001",
                source_ip="192.0.2.10", csrf_token=CSRF, csrf_verified=True)


def signed(c, raw=None):
    assertion = b64(raw or json.dumps(c, ensure_ascii=False, separators=(",", ":")).encode())
    return [(b"x-pl-gateway-assertion", assertion.encode()),
            (b"x-pl-gateway-signature", b64(hmac.digest(KEY, b"pl-gateway-v1\n" + assertion.encode(), "sha256")).encode()),
            (b"content-type", c["content_type"].encode()), (b"idempotency-key", c["idempotency_key"].encode()),
            (b"x-csrf-token", CSRF.encode())]


def scope(c):
    path, _, query = c["uri"].partition("?")
    return dict(method=c["method"], raw_path=path.encode(), query_string=query.encode(), headers=signed(c))


@pytest.fixture
def verifier(tmp_path):
    key = tmp_path / "key"
    key.write_bytes(KEY)
    result = GatewayVerifier(key)
    result.validate_configuration()
    return result


def test_public_vector(verifier):
    # These exact bytes are checked by Go TestGatewayIdentityPublishedPythonVector.
    c = PUBLIC_VECTOR["claims"]
    assert claims() == c
    assert PUBLIC_VECTOR["signature"] == "TUhJ6q8-O85ImARF0JqL6ZfwHdqCK8DW1mpGKwbAsWU"
    request = scope(c)
    request["headers"][:2] = [
        (b"x-pl-gateway-assertion", PUBLIC_VECTOR["assertion"].encode()),
        (b"x-pl-gateway-signature", PUBLIC_VECTOR["signature"].encode()),
    ]
    assert verifier.verify(request, BODY, now=1790000000)["sub"] == "ad:test-user"


@pytest.mark.parametrize("field,value", [("method", "DELETE"), ("raw_path", b"/different"), ("query_string", b"check=a/b&check=c")])
def test_raw_request_tamper(verifier, field, value):
    request = scope(claims()); request[field] = value
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)


@pytest.mark.parametrize("field,value", [("aud", "websites-admin"), ("admin", False), ("v", True),
                                        ("iat", 1790000040), ("exp", 1789999990), ("scopes", ["evil"]),
                                        ("csrf_verified", False)])
def test_invalid_signed_claims(verifier, field, value):
    c = claims(); c[field] = value
    with pytest.raises(GatewayError): verifier.verify(scope(c), BODY, now=1790000000)


@pytest.mark.parametrize("header,value", [(b"content-type", b"text/plain"), (b"idempotency-key", b"other"),
                                         (b"x-csrf-token", b"\xff"),
                                         (b"x-csrf-token", b"wrong"), (b"x-pl-gateway-signature", b"AAAA")])
def test_header_tamper(verifier, header, value):
    request = scope(claims()); request["headers"] = [(k, value if k == header else v) for k, v in request["headers"]]
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)


def test_body_duplicate_missing_and_replay(verifier):
    c = claims(); request = scope(c)
    with pytest.raises(GatewayError): verifier.verify(request, BODY+b" ", now=1790000000)
    request["headers"].append(request["headers"][0])
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)
    request = scope(c)
    raw = json.dumps(c).encode()[:-1] + b',"sub":"other"}'
    request["headers"] = signed(c, raw)
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)
    raw = dict(c); del raw["source_ip"]
    request["headers"] = signed(c, json.dumps(raw).encode())
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)
    def consume(_):
        try:
            verifier.verify(scope(c), BODY, now=1790000000)
            return 200
        except GatewayError as exc: return exc.status
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(consume, range(2))) == [200, 409]


def test_startup_key_exact_length(verifier):
    verifier.key_file.write_bytes(KEY + b"\n")
    with pytest.raises(RuntimeError): verifier.validate_configuration()


def test_surrogate_identity_rejected(verifier):
    c = claims(); c["name"] = "\ud800"
    request = scope(claims()); request["headers"] = signed(c, json.dumps(c).encode())
    with pytest.raises(GatewayError): verifier.verify(request, BODY, now=1790000000)


def test_missing_key_prevents_lifespan(settings, tmp_path):
    app = create_app(replace(settings, auth_provider="gateway", gateway_key_file=tmp_path / "absent"))
    with pytest.raises(RuntimeError, match="Gateway key"):
        with TestClient(app): pass


def test_gateway_prefix_no_session_fallback_and_body_preserved(settings, verifier):
    settings = replace(settings, auth_provider="gateway", gateway_key_file=verifier.key_file)
    app = create_app(settings); Base.metadata.create_all(app.state.engine)
    from test_web import FakeAgent
    app.state.agent = FakeAgent()
    with TestClient(app) as client:
        assert client.get("/admin/health").status_code == 200
        assert client.get("/admin/api/v1/session", headers={"Cookie": "session=anything", "X-Auth-User": "admin"}).status_code == 401
        c = claims(int(time.time()))
        c.update(method="GET", uri="/admin/api/v1/session", content_type="", body_sha256=hashlib.sha256(b"").hexdigest(), idempotency_key="", csrf_verified=False)
        response = client.get(c["uri"], headers=dict((k.decode(), v.decode()) for k, v in signed(c)))
        assert response.status_code == 200
        assert response.json()["csrf_token"] == CSRF
        assert "set-cookie" not in response.headers
        c = claims(int(time.time())); c["uri"] = "/admin/api/v1/containers/prometheus/restart"
        response = client.post(c["uri"], content=BODY, headers=dict((k.decode(), v.decode()) for k, v in signed(c)))
        assert response.status_code == 202, response.text
        assert response.json()["requested_by"] == "ad:test-user"
        assert client.post(c["uri"], content=BODY, headers=dict((k.decode(), v.decode()) for k, v in signed(c))).status_code == 409


def test_positive_published_monitoring_vector_from_core_go(verifier):
    """Consume literal bytes also verified by Go's real signer regression test."""
    fixture = json.loads((CONTRACT.parent / 'examples/admin-v1-vectors.json').read_text())
    assert fixture['schema'] == 1
    assert fixture['key_raw_ascii'].encode() == KEY
    vector = next(item for item in fixture['cases'] if item['claims']['aud'] == 'monitoring-admin')
    c = vector['claims']
    path, _, query = c['uri'].partition('?')
    request = dict(method=c['method'], raw_path=path.encode(), query_string=query.encode(), headers=[
        (b'x-pl-gateway-assertion', vector['assertion'].encode()),
        (b'x-pl-gateway-signature', vector['signature'].encode()),
        (b'content-type', c['content_type'].encode()),
        (b'idempotency-key', c['idempotency_key'].encode()),
        (b'x-csrf-token', c['csrf_token'].encode()),
    ])
    identity = verifier.verify(request, vector['body_utf8'].encode(), now=c['iat'])
    assert identity['sub'] == c['sub']
    assert identity['csrf_token'] == vector['expected_service_csrf']
