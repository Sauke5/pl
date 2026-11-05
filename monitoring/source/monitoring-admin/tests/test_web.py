from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app
from app.database import Base


class FakeAgent:
    services = frozenset({"prometheus", "monitoring-admin"})
    restartable = frozenset({"prometheus"})
    async def overview(self): return {"ok": True, "services": [{"service_id": "prometheus", "state": "running"}, {"service_id": "evil", "state": "running"}]}
    async def logs(self, service_id, tail): return {"service_id": service_id, "lines": ["token=secret-value"]}
    def require_service(self, service_id, restart=False):
        if service_id not in (self.restartable if restart else self.services): raise ValueError


class FakeReports:
    async def deliveries(self, limit): return {"ok": True, "deliveries": []}
    async def diagnostics(self): return {"ok": True, "reports": {"total": 1}}


class FakeHealth:
    async def check_all(self, service_ids):
        return {item: {"service_id": item, "status": "healthy"} for item in service_ids}


def login(client: TestClient):
    page = client.get("/login")
    token = re.search(r'name="csrf_token" value="([^"]+)', page.text).group(1)
    response = client.post("/login", data={"csrf_token": token, "username": "admin", "password": "correct horse battery"},
                           headers={"Origin": "http://testserver", "Cookie": f"login_csrf={token}"}, follow_redirects=False)
    session_token = re.search(r"session=([^;]+)", response.headers.get("set-cookie", "")).group(1)
    client.cookies.set("session", session_token, path="/")
    return response


def test_auth_overview_scrubbing_csrf_and_allowlist(settings):
    app = create_app(settings); app.state.agent = FakeAgent(); app.state.reports = FakeReports(); app.state.health_client = FakeHealth()
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="http://testserver") as client:
        assert client.get("/api/v1/overview").status_code == 401
        assert login(client).status_code == 303
        page = client.get("/")
        assert page.status_code == 200
        assert '/admin/static/ecosystem/ui-v1.js' in page.text
        assert 'Локальная учётная запись' in page.text
        assert 'id="logout-form"' in page.text
        for name in ('ui-v1.js', 'ui-v1.css', 'theme-catalog.js', 'theme-runtime.js', 'theme-menu.css'):
            asset = client.get('/admin/static/ecosystem/' + name)
            assert asset.status_code == 200
            assert asset.content == (Path(__file__).resolve().parents[2] / 'it-portal/frontend/public/ecosystem' / name).read_bytes()
        assert page.text.count('data-view="') == 5
        assert 'data-view="overview"' in page.text
        for section in ("containers", "telegram", "diagnostics", "operations"):
            assert f'data-view="{section}" hidden' in page.text
        session = client.get("/api/v1/session").json()
        proxy_auth = client.get("/api/v1/proxy-auth")
        assert proxy_auth.status_code == 204
        assert proxy_auth.headers["x-auth-user"] == "admin"
        overview = client.get("/api/v1/overview").json()
        assert [item["service_id"] for item in overview["services"]] == ["prometheus"]
        assert overview["services"][0]["application_health"]["status"] == "healthy"
        assert client.get("/api/v1/containers/prometheus/logs").json()["lines"] == ["token=[REDACTED]"]
        assert client.post("/api/v1/containers/prometheus/restart", headers={"X-CSRF-Token": session["csrf_token"]}).status_code == 403
        response = client.post("/api/v1/containers/prometheus/restart",
                               headers={"Origin": "http://testserver", "X-CSRF-Token": session["csrf_token"], "Idempotency-Key": "web-test"})
        assert response.status_code == 202


def test_proxy_auth_requires_session(settings):
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/v1/proxy-auth", follow_redirects=False)
        assert response.status_code == 401


def test_login_returns_to_dozzle_and_rejects_external_redirect(settings):
    app = create_app(settings)
    Base.metadata.create_all(app.state.engine)
    with TestClient(app, base_url="http://testserver") as client:
        page = client.get("/login?next=/admin/logs/")
        token = re.search(r'name="csrf_token" value="([^"]+)', page.text).group(1)
        assert 'name="next" value="/admin/logs/"' in page.text
        response = client.post(
            "/login",
            data={"csrf_token": token, "username": "admin", "password": "correct horse battery",
                  "next": "/admin/logs/"},
            headers={"Origin": "http://testserver", "Cookie": f"login_csrf={token}"},
            follow_redirects=False,
        )
        assert response.status_code == 303
        assert response.headers["location"] == "/admin/logs/"

        unsafe = client.get("/login?next=https://evil.example/", follow_redirects=False)
        assert unsafe.status_code == 200
        assert 'name="next"' not in unsafe.text
        assert "evil.example" not in unsafe.text
