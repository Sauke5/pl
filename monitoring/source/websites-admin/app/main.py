from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.auth.service import AuthService
from app.auth.gateway import GatewayMiddleware, GatewayVerifier, read_key
from app.config import Settings, get_settings
from app.logging_config import configure_logging
from app.repositories.config import ConfigRepository
from app.routes import auth as auth_routes
from app.routes import health as health_routes
from app.routes import websites as website_routes
from app.services.apply import ConfigApplyService
from app.services.backup import BackupManager
from app.services.blackbox import BlackboxValidator
from app.services.fetcher import SafeFetcher
from app.services.notifier import TelegramNotifier
from app.services.prometheus import PrometheusClient

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Services:
    settings: Settings
    templates: Jinja2Templates
    auth: AuthService
    repository: ConfigRepository
    fetcher: SafeFetcher
    prometheus: PrometheusClient
    backups: BackupManager
    validator: BlackboxValidator
    notifier: TelegramNotifier
    apply: ConfigApplyService


settings = get_settings()
configure_logging(settings.log_level)
app_directory = Path(__file__).resolve().parent
templates = Jinja2Templates(directory=str(app_directory / "templates"))
repository = ConfigRepository(settings.websites_file, settings.content_file, settings.blackbox_file)
backups = BackupManager(settings.backups_dir, repository, settings.backup_keep)
validator = BlackboxValidator(settings)
notifier = TelegramNotifier(settings)
services = Services(
    settings=settings,
    templates=templates,
    auth=AuthService(settings),
    repository=repository,
    fetcher=SafeFetcher(settings),
    prometheus=PrometheusClient(settings),
    backups=backups,
    validator=validator,
    notifier=notifier,
    apply=ConfigApplyService(settings, repository, backups, validator, notifier),
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.backups_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(
    title=settings.app_name,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    root_path=settings.root_path,
    lifespan=lifespan,
)
app.state.services = services
if settings.auth_mode == "gateway":
    app.add_middleware(GatewayMiddleware, verifier=GatewayVerifier(read_key(settings.platform_sso_key_file)))
app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=list(settings.trusted_hosts),
)


@app.middleware("http")
async def security_headers(request: Request, call_next):  # type: ignore[no-untyped-def]
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.url.path != "/health":
        response.headers.setdefault("Cache-Control", "no-store, private")
    return response


app.mount("/static", StaticFiles(directory=str(app_directory / "static")), name="static")
app.include_router(health_routes.router)
app.include_router(auth_routes.router)
app.include_router(website_routes.router)


@app.exception_handler(403)
async def forbidden(request: Request, exc):  # type: ignore[no-untyped-def]
    return services.templates.TemplateResponse(
        request=request,
        name="error.html",
        context={"request": request, "title": "Доступ запрещён", "status": 403, "message": getattr(exc, "detail", str(exc))},
        status_code=403,
    )


@app.exception_handler(404)
async def not_found(request: Request, _exc):  # type: ignore[no-untyped-def]
    return services.templates.TemplateResponse(
        request=request,
        name="error.html",
        context={"request": request, "title": "Страница не найдена", "status": 404, "message": "Запрошенная страница не существует."},
        status_code=404,
    )


@app.exception_handler(Exception)
async def unhandled(request: Request, exc):  # type: ignore[no-untyped-def]
    logger.exception("unhandled_request_error", exc_info=exc, extra={"path": request.url.path})
    if request.url.path == "/health":
        return JSONResponse({"status": "error"}, status_code=503)
    return services.templates.TemplateResponse(
        request=request,
        name="error.html",
        context={
            "request": request,
            "title": "Внутренняя ошибка",
            "status": 500,
            "message": "Операция не выполнена. Технические сведения записаны в журнал.",
        },
        status_code=500,
    )
