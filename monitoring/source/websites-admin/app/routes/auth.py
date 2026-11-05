from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.auth.service import source_ip
from app.database import get_db
from app.web import require_csrf

router = APIRouter()


@router.get("/login", response_class=HTMLResponse, name="login_get")
async def login_get(request: Request, db: Session = Depends(get_db)):
    services = request.app.state.services
    if services.settings.auth_mode == "gateway":
        return RedirectResponse("/", status_code=303)
    if services.auth.get_context(db, request):
        return RedirectResponse(str(request.url_for("home")), status_code=303)
    token = services.auth.new_login_csrf()
    response = services.templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"request": request, "title": "Вход", "error": None, "login_csrf": token},
    )
    services.auth.issue_login_csrf(response, token)
    return response


@router.post("/login", name="login_post")
async def login_post(request: Request, db: Session = Depends(get_db)):
    services = request.app.state.services
    if services.settings.auth_mode == "gateway":
        return RedirectResponse("/", status_code=303)
    form = await request.form()
    if not services.auth.verify_login_csrf(request, form.get("csrf_token")):
        token = services.auth.new_login_csrf()
        response = services.templates.TemplateResponse(
            request=request,
            name="login.html",
            context={"request": request, "title": "Вход", "error": "Сессия формы истекла. Повторите вход.", "login_csrf": token},
            status_code=403,
        )
        services.auth.issue_login_csrf(response, token)
        return response
    user = await services.auth.authenticate(db, str(form.get("username", "")), str(form.get("password", "")), source_ip(request))
    if not user:
        token = services.auth.new_login_csrf()
        response = services.templates.TemplateResponse(
            request=request,
            name="login.html",
            context={"request": request, "title": "Вход", "error": "Неверный логин или пароль.", "login_csrf": token},
            status_code=401,
        )
        services.auth.issue_login_csrf(response, token)
        return response
    response = RedirectResponse(str(request.url_for("home")), status_code=303)
    services.auth.create_session(
        db,
        user,
        source_ip(request),
        response,
        previous_token=request.cookies.get(services.settings.session_cookie),
    )
    response.delete_cookie(services.settings.csrf_cookie, path=f"{services.settings.root_path}/login")
    return response


@router.post("/logout", name="logout")
async def logout(request: Request, db: Session = Depends(get_db)):
    services = request.app.state.services
    if services.settings.auth_mode == "gateway":
        return RedirectResponse("/", status_code=303)
    context = services.auth.get_context(db, request)
    if not context:
        return RedirectResponse(str(request.url_for("login_get")), status_code=303)
    form = await request.form()
    require_csrf(request, context, form)
    response = RedirectResponse(str(request.url_for("login_get")), status_code=303)
    services.auth.logout(db, request, response)
    return response
