from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.auth.providers import build_authentication_provider
from app.auth.service import AuthService
from app.auth.gateway import GatewayMiddleware, GatewayVerifier
from app.clients import AgentClient, ReportRunnerClient
from app.config import Settings, get_settings
from app.database import create_database
from app.jobs import JobService
from app.health import ServiceHealthClient
from app.web import build_router

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine, factory = create_database(settings.database_url)
    gateway = GatewayVerifier(settings.gateway_key_file) if settings.auth_provider == "gateway" else None
    provider = None if gateway else build_authentication_provider(settings.auth_provider, settings.credentials_file)
    auth = AuthService(settings, provider) if provider else None
    agent = AgentClient(settings.agent_socket, settings.agent_timeout_seconds,
                        settings.service_allowlist, settings.restart_allowlist, settings.agent_restart_timeout_seconds)
    reports = ReportRunnerClient(settings.report_runner_url, settings.report_runner_timeout_seconds)
    jobs = JobService(factory)
    health = ServiceHealthClient(settings.health_timeout_seconds, settings.health_poll_seconds)
    app_dir = Path(__file__).resolve().parent
    templates = Jinja2Templates(directory=str(app_dir / "templates"))
    templates.env.globals["settings"] = settings

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        (gateway or provider).validate_configuration()
        yield
        engine.dispose()

    application = FastAPI(title=settings.app_name, docs_url=None, redoc_url=None, openapi_url=None,
                          root_path=settings.root_path, lifespan=lifespan)
    application.state.settings = settings
    application.state.engine = engine
    application.state.session_factory = factory
    application.state.auth = auth
    application.state.agent = agent
    application.state.reports = reports
    application.state.jobs = jobs
    application.state.health_client = health
    application.state.templates = templates
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts))
    if gateway:
        application.add_middleware(GatewayMiddleware, verifier=gateway)

    @application.middleware("http")
    async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
        if request.url.path != "/health":
            response.headers.setdefault("Cache-Control", "no-store, private")
        return response

    static_dir = app_dir / "static"
    if static_dir.exists():
        application.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    application.include_router(build_router())

    @application.exception_handler(401)
    async def unauthorized(request: Request, exc):  # type: ignore[no-untyped-def]
        if "/api/" in request.url.path or gateway:
            return JSONResponse({"detail": getattr(exc, "detail", "authentication_required")}, status_code=401)
        from fastapi.responses import RedirectResponse
        return RedirectResponse(f"{settings.root_path}/login", 303)

    return application


app = create_app()
