from __future__ import annotations

import re
import secrets
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from app.auth.service import AuthContext, source_ip
from app.clients import UpstreamError
from app.jobs import JobConflict, serialize_job


SECRET_PATTERNS = (
    re.compile(r"(?i)(bot\d*:)[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?i)((?:password|token|secret|authorization)\s*[=:]\s*)\S+"),
)


def scrub(value: Any) -> Any:
    if isinstance(value, str):
        for pattern in SECRET_PATTERNS:
            value = pattern.sub(r"\1[REDACTED]", value)
        return value[:131072]
    if isinstance(value, list):
        return [scrub(item) for item in value[:200]]
    if isinstance(value, dict):
        return {str(key): scrub(item) for key, item in list(value.items())[:200]}
    return value


def _context(request: Request) -> AuthContext | None:
    if request.app.state.settings.auth_provider == "gateway":
        return getattr(request.state, "gateway_context", None)
    with request.app.state.session_factory() as db:
        return request.app.state.auth.get_context(db, request)


def _require(request: Request, scope: str = "monitoring:read") -> AuthContext:
    context = _context(request)
    if context is None:
        raise HTTPException(401, "authentication_required")
    if not context.principal.has_scope(scope):
        raise HTTPException(403, "insufficient_scope")
    return context


def _csrf(request: Request, context: AuthContext, supplied: str | None) -> None:
    from app.auth.service import AuthService
    if not AuthService.csrf_ok(context, supplied):
        raise HTTPException(403, "invalid_csrf_token")


def _same_origin(request: Request) -> None:
    if getattr(request.state, "gateway_claims", None):
        # The signed assertion confirms the portal's strict origin check.
        return
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",", 1)[0].strip().lower()
    scheme = (request.headers.get("x-forwarded-proto") or request.url.scheme).split(",", 1)[0].strip().lower()
    origin = request.headers.get("origin")
    referer = request.headers.get("referer")
    candidate = origin or referer
    parsed = urlsplit(candidate) if candidate else None
    if not parsed or parsed.netloc.lower() != host or parsed.scheme.lower() != scheme:
        raise HTTPException(403, "invalid_request_origin")


def _safe_login_next(request: Request, value: str | None) -> str:
    candidate = (value or "").strip()
    parsed = urlsplit(candidate)
    allowed_prefix = f"{request.app.state.settings.root_path}/logs/"
    if (not candidate or parsed.scheme or parsed.netloc or parsed.fragment or "\\" in candidate
            or not parsed.path.startswith(allowed_prefix)):
        return ""
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


class RestartRequest(BaseModel):
    idempotency_key: str | None = None


def build_router() -> APIRouter:
    router = APIRouter()

    @router.get("/health")
    async def health(request: Request) -> dict[str, str]:
        try:
            with request.app.state.session_factory() as db:
                db.execute(__import__("sqlalchemy").text("SELECT 1"))
            return {"status": "ok"}
        except Exception as exc:
            raise HTTPException(503, "database_unavailable") from exc

    @router.get("/login", response_class=HTMLResponse)
    async def login_page(request: Request):
        if request.app.state.settings.auth_provider == "gateway":
            return RedirectResponse("/", 303)
        next_path = _safe_login_next(request, request.query_params.get("next"))
        if _context(request):
            return RedirectResponse(next_path or f"{request.app.state.settings.root_path}/", 303)
        token = secrets.token_urlsafe(32)
        response = request.app.state.templates.TemplateResponse(request=request, name="login.html",
                                                                context={"request": request, "error": None,
                                                                         "login_csrf": token, "next_path": next_path})
        request.app.state.auth.issue_login_csrf(response, token)
        return response

    @router.post("/login")
    async def login_submit(request: Request):
        if request.app.state.settings.auth_provider == "gateway":
            raise HTTPException(404, "local_login_disabled")
        _same_origin(request)
        form = await request.form()
        next_path = _safe_login_next(request, str(form.get("next", "")))
        if not request.app.state.auth.login_csrf_ok(request, str(form.get("csrf_token", ""))):
            raise HTTPException(403, "invalid_csrf_token")
        with request.app.state.session_factory() as db:
            principal = await request.app.state.auth.authenticate(db, str(form.get("username", "")),
                                                                  str(form.get("password", "")), source_ip(request))
            if principal is None:
                token = secrets.token_urlsafe(32)
                response = request.app.state.templates.TemplateResponse(
                    request=request, name="login.html",
                    context={"request": request, "error": "Неверный логин или пароль",
                             "login_csrf": token, "next_path": next_path}, status_code=401)
                request.app.state.auth.issue_login_csrf(response, token)
                return response
            response = RedirectResponse(next_path or f"{request.app.state.settings.root_path}/", 303)
            request.app.state.auth.create_session(db, principal, source_ip(request), response)
            return response

    @router.post("/logout")
    async def logout(request: Request):
        if request.app.state.settings.auth_provider == "gateway":
            raise HTTPException(409, "use_portal_logout")
        _same_origin(request)
        context = _require(request)
        form = await request.form()
        _csrf(request, context, str(form.get("csrf_token", "")))
        response = RedirectResponse(f"{request.app.state.settings.root_path}/login", 303)
        with request.app.state.session_factory() as db:
            request.app.state.auth.logout(db, request, response)
        return response

    async def render_page(request: Request, template: str, title: str):
        context = _context(request)
        if context is None:
            return RedirectResponse(f"{request.app.state.settings.root_path}/login", 303)
        return request.app.state.templates.TemplateResponse(
            request=request, name=template,
            context={"request": request, "title": title, "principal": context.principal,
                     "csrf_token": context.csrf_token})

    @router.get("/", response_class=HTMLResponse)
    async def index(request: Request): return await render_page(request, "index.html", "Обзор")

    @router.get("/containers")
    @router.get("/telegram")
    @router.get("/diagnostics")
    @router.get("/operations")
    async def section_redirect(request: Request):
        section = request.url.path.rsplit("/", 1)[-1]
        if _context(request) is None:
            return RedirectResponse(f"{request.app.state.settings.root_path}/login", 303)
        return RedirectResponse(f"{request.app.state.settings.root_path}/#{section}", 302)

    @router.get("/api/v1/session")
    async def session_info(request: Request):
        context = _require(request)
        return {"username": context.principal.username, "scopes": sorted(context.principal.scopes),
                "csrf_token": context.csrf_token, "auth_mode": request.app.state.settings.auth_provider}

    @router.get("/api/v1/proxy-auth", status_code=204)
    async def proxy_auth(request: Request):
        context = _context(request)
        if context is None:
            return Response(status_code=401)
        if not context.principal.has_scope("monitoring:read"):
            return Response(status_code=403)
        return Response(status_code=204, headers={"X-Auth-User": context.principal.username})

    @router.get("/api/v1/overview")
    async def overview(request: Request):
        _require(request)
        try:
            raw, service_health = await __import__("asyncio").gather(
                request.app.state.agent.overview(),
                request.app.state.health_client.check_all(request.app.state.settings.service_allowlist),
            )
        except UpstreamError as exc:
            raise HTTPException(503, {"code": exc.code, "message": str(exc)}) from exc
        services = raw.get("services", raw.get("containers", []))
        if not isinstance(services, list):
            services = []
        allowed = request.app.state.agent.services
        filtered = []
        for item in services:
            if not isinstance(item, dict):
                continue
            service_id = item.get("service_id", item.get("id"))
            if service_id in allowed:
                filtered.append({**item, "application_health": service_health.get(service_id)})
        running = sum(item.get("running") is True or str(item.get("state", item.get("status", ""))).lower() in {"running", "up"} for item in filtered)
        healthy = sum((item.get("application_health") or {}).get("status") == "healthy" for item in filtered)
        attention = sum(
            not (item.get("running") is True or str(item.get("state", item.get("status", ""))).lower() in {"running", "up"})
            or (item.get("application_health") or {}).get("status") == "unhealthy"
            for item in filtered
        )
        summary = {"running": running, "healthy": healthy, "attention": attention,
                   **(raw.get("summary", {}) if isinstance(raw.get("summary"), dict) else {})}
        return scrub({**raw, "containers": filtered, "services": filtered, "service_health": service_health, "summary": summary})

    @router.get("/api/v1/containers")
    async def containers(request: Request):
        return await overview(request)

    @router.get("/api/v1/containers/{service_id}/logs")
    async def container_logs(service_id: str, request: Request, tail: int = 50):
        _require(request)
        try:
            return scrub(await request.app.state.agent.logs(service_id, tail))
        except ValueError as exc:
            raise HTTPException(404, "service_not_allowed") from exc
        except UpstreamError as exc:
            raise HTTPException(503, {"code": exc.code, "message": str(exc)}) from exc

    @router.post("/api/v1/containers/{service_id}/restart", status_code=202)
    async def restart_container(service_id: str, request: Request, payload: RestartRequest | None = None):
        _same_origin(request)
        context = _require(request, "containers:restart")
        _csrf(request, context, request.headers.get("x-csrf-token"))
        try:
            request.app.state.agent.require_service(service_id, restart=True)
        except ValueError as exc:
            raise HTTPException(404, "service_not_restartable") from exc
        key = request.headers.get("idempotency-key") or (payload.idempotency_key if payload else None) or secrets.token_urlsafe(24)
        try:
            actor = context.principal.subject if context.principal.provider == "gateway" else context.principal.username
            job = request.app.state.jobs.enqueue_restart(service_id, actor, source_ip(request), key)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except JobConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        return serialize_job(job)

    @router.get("/api/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request):
        _require(request)
        job = request.app.state.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "job_not_found")
        return serialize_job(job)

    @router.get("/api/v1/deliveries")
    async def deliveries(request: Request, limit: int = 50):
        _require(request)
        try:
            return scrub(await request.app.state.reports.deliveries(limit))
        except UpstreamError as exc:
            raise HTTPException(503, {"code": exc.code, "message": str(exc)}) from exc

    @router.get("/api/v1/diagnostics")
    async def diagnostics(request: Request):
        _require(request)
        checks: list[dict[str, Any]] = []
        try:
            agent = await request.app.state.agent.overview()
            checks.append({"id": "agent", "status": "pass", "label": "Agent управления доступен"})
            services = agent.get("services", []) if isinstance(agent.get("services"), list) else []
            stopped = [item.get("service_id") for item in services if isinstance(item, dict) and item.get("running") is not True]
            checks.append({"id": "containers", "status": "fail" if stopped else "pass",
                           "label": "Контейнеры Docker",
                           "message": f"Не работают: {', '.join(str(item) for item in stopped)}" if stopped else f"Работают: {len(services)}"})
            unhealthy_docker = [item.get("service_id") for item in services if isinstance(item, dict) and item.get("health") == "unhealthy"]
            checks.append({"id": "docker_health", "status": "fail" if unhealthy_docker else "pass",
                           "label": "Docker health-check",
                           "message": f"Unhealthy: {', '.join(str(item) for item in unhealthy_docker)}" if unhealthy_docker else "Unhealthy-контейнеров нет"})
        except UpstreamError as exc:
            agent = None; checks.append({"id": "agent", "status": "fail", "label": str(exc)})
        service_health = await request.app.state.health_client.check_all(request.app.state.settings.service_allowlist)
        unhealthy = [key for key, value in service_health.items() if value.get("status") == "unhealthy"]
        checks.append({"id": "service_health", "status": "fail" if unhealthy else "pass",
                       "label": "Health сервисов", "message": f"Не прошли: {', '.join(unhealthy)}" if unhealthy else "Настроенные проверки пройдены"})
        try:
            reports = await request.app.state.reports.diagnostics()
            checks.append({"id": "reports", "status": "pass" if reports.get("ok") else "warn",
                           "label": "Сервис отчётов доступен"})
            delivery_db = reports.get("delivery_database", {}) if isinstance(reports.get("delivery_database"), dict) else {}
            pending = int(delivery_db.get("pending_count") or 0)
            checks.append({"id": "telegram_delivery", "status": "fail" if not delivery_db.get("available", True) else ("warn" if pending else "pass"),
                           "label": "Очередь доставки Telegram", "message": f"Ожидают отправки: {pending}" if pending else "Очередь пуста"})
            report_data = reports.get("reports", {}) if isinstance(reports.get("reports"), dict) else {}
            checks.append({"id": "report_manifest", "status": "pass" if report_data.get("manifest_available", True) else "fail",
                           "label": "Архив отчётов", "message": f"Отчётов: {report_data.get('total', 0)}"})
        except UpstreamError as exc:
            reports = None; checks.append({"id": "reports", "status": "fail", "label": str(exc)})
        return scrub({"generated_at": datetime.now().astimezone().isoformat(), "status": "pass" if all(c["status"] == "pass" for c in checks) else "degraded",
                      "checks": checks, "agent": agent, "service_health": service_health, "reports": reports})

    @router.get("/api/v1/audit")
    async def audit(request: Request, limit: int = 50):
        _require(request, "audit:read")
        events = request.app.state.jobs.list_audit(min(max(limit, 1), 100))
        return {"events": [{"id": e.id, "event_type": e.event_type, "username": e.username,
                            "target": e.target, "outcome": e.outcome, "job_id": e.job_id,
                            "details": scrub(e.details), "created_at": e.created_at} for e in events]}

    return router
