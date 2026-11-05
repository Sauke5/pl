from __future__ import annotations

import os
import tempfile

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.database import SessionLocal

router = APIRouter()


def _writable(path) -> bool:  # type: ignore[no-untyped-def]
    path.mkdir(parents=True, exist_ok=True)
    descriptor, filename = tempfile.mkstemp(prefix=".health-", dir=path)
    os.close(descriptor)
    os.unlink(filename)
    return True


@router.get("/health", name="health")
async def health(request: Request):
    services = request.app.state.services
    checks: dict[str, bool] = {}
    errors: dict[str, str] = {}
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        checks["sqlite"] = True
    except Exception as exc:
        checks["sqlite"] = False
        errors["sqlite"] = type(exc).__name__
    try:
        for path in services.repository.paths.values():
            with path.open("rb") as stream:
                stream.read(1)
        checks["config_read"] = True
    except Exception as exc:
        checks["config_read"] = False
        errors["config_read"] = type(exc).__name__
    for name, path in (("data_write", services.settings.data_dir), ("backups_write", services.settings.backups_dir)):
        try:
            checks[name] = _writable(path)
        except Exception as exc:
            checks[name] = False
            errors[name] = type(exc).__name__
    healthy = all(checks.values())
    return JSONResponse(
        {"status": "ok" if healthy else "error", "checks": checks, "errors": errors},
        status_code=200 if healthy else 503,
        headers={"Cache-Control": "no-store"},
    )
