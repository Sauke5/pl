from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.auth.service import AuthContext


@dataclass(slots=True)
class PageContext:
    auth: AuthContext


def require_auth(request: Request, db: Session) -> AuthContext | RedirectResponse:
    context = request.app.state.services.auth.get_context(db, request)
    if context:
        return context
    if request.app.state.services.settings.auth_mode == "gateway":
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="Доступ к сервису не разрешён. Вернитесь в Платформу.")
    return RedirectResponse(str(request.url_for("login_get")), status_code=303)


def csrf_from_request(request: Request, form) -> str | None:  # type: ignore[no-untyped-def]
    return request.headers.get("x-csrf-token") or form.get("csrf_token")


def require_csrf(request: Request, auth: AuthContext, form) -> None:  # type: ignore[no-untyped-def]
    submitted = csrf_from_request(request, form)
    if not request.app.state.services.auth.verify_csrf(auth, submitted):
        from fastapi import HTTPException

        raise HTTPException(status_code=403, detail="CSRF-проверка не пройдена. Обновите страницу.")
