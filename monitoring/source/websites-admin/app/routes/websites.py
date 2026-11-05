from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.service import AuthContext, source_ip
from app.database import get_db
from app.models import AuditEvent
from app.repositories.config import ConfigError, TargetNotFoundError
from app.services.apply import ApplyError
from app.services.content import extract_candidates, verify_fragments
from app.services.fetcher import FetchError, validate_url
from app.web import require_auth, require_csrf

router = APIRouter()


def _base(request: Request, auth: AuthContext, **values: Any) -> dict[str, Any]:
    context = {
        "request": request,
        "auth": auth,
        "csrf_token": auth.session.csrf_token,
        "root_path": request.app.state.services.settings.root_path,
    }
    context.update(values)
    return context


def _auth_or_redirect(request: Request, db: Session):
    return require_auth(request, db)


def _operation_error(request: Request, auth: AuthContext, exc: Exception, status_code: int = 422):
    operation_id = exc.operation_id if isinstance(exc, ApplyError) else None
    return request.app.state.services.templates.TemplateResponse(
        request=request,
        name="operation_error.html",
        context=_base(
            request,
            auth,
            title="Изменение не применено",
            message=str(exc),
            operation_id=operation_id,
            force_required=isinstance(exc, ApplyError) and exc.force_required,
        ),
        status_code=status_code,
    )


@router.get("/", response_class=HTMLResponse, name="home")
async def home(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    try:
        documents = services.repository.load_documents()
        state = services.repository.build_state(documents)
    except ConfigError as exc:
        return services.templates.TemplateResponse(
            request=request,
            name="config_error.html",
            context=_base(request, auth, title="Ошибка конфигурации", message=str(exc)),
            status_code=503,
        )
    statuses = await services.prometheus.status_for(state.targets)
    rows = [{"target": target, "status": statuses[target.url]} for target in state.targets]
    query = request.query_params.get("q", "").strip().casefold()
    state_filter = request.query_params.get("state", "all")
    counters = {
        "all": len(rows),
        "healthy": sum(row["status"].state == "Исправен" for row in rows),
        "problem": sum(row["status"].state_class in {"error", "warning", "unknown"} for row in rows),
        "disabled": sum(not row["target"].content_enabled for row in rows),
    }
    if query:
        rows = [row for row in rows if query in row["target"].url.casefold() or query in row["target"].title.casefold()]
    if state_filter == "healthy":
        rows = [row for row in rows if row["status"].state == "Исправен"]
    elif state_filter == "problem":
        rows = [row for row in rows if row["status"].state_class in {"error", "warning", "unknown"}]
    elif state_filter == "disabled":
        rows = [row for row in rows if not row["target"].content_enabled]
    message = request.query_params.get("message")
    warning = request.query_params.get("warning")
    return services.templates.TemplateResponse(
        request=request,
        name="index.html",
        context=_base(
            request,
            auth,
            title="Управление сайтами",
            rows=rows,
            counters=counters,
            query=request.query_params.get("q", ""),
            state_filter=state_filter,
            global_errors=state.global_errors,
            message=message,
            warning=warning,
        ),
    )


@router.get("/targets/{site_id}", response_class=HTMLResponse, name="target_detail")
async def target_detail(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    try:
        documents = services.repository.load_documents()
        state = services.repository.build_state(documents)
        target = state.by_site_id(site_id)
    except (ConfigError, TargetNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    status = (await services.prometheus.status_for([target]))[target.url]
    fragment_presence: dict[str, bool] = {}
    fragment_error = None
    if target.content_enabled and target.fragments and not target.config_error:
        try:
            fetched = await services.fetcher.fetch(target.url)
            fragment_presence = verify_fragments(fetched.text, target.fragments)
        except FetchError as exc:
            fragment_error = str(exc)
    history = list(
        db.scalars(select(AuditEvent).where(AuditEvent.url == target.url).order_by(AuditEvent.created_at.desc()).limit(10))
    )
    disable_token = services.auth.issue_operation_token(db, auth, "content_disable", target.url)
    return services.templates.TemplateResponse(
        request=request,
        name="detail.html",
        context=_base(
            request,
            auth,
            title=target.title,
            target=target,
            status=status,
            revision=state.revision,
            fragment_presence=fragment_presence,
            fragment_error=fragment_error,
            history=history,
            disable_token=disable_token,
            message=request.query_params.get("message"),
            warning=request.query_params.get("warning"),
        ),
    )


@router.get("/targets/{site_id}/update", response_class=HTMLResponse, name="target_update_get")
async def target_update_get(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    try:
        documents = services.repository.load_documents()
        state = services.repository.build_state(documents)
        target = state.by_site_id(site_id)
    except (ConfigError, TargetNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if target.config_error:
        return _operation_error(request, auth, ConfigError(target.config_error), 409)
    try:
        fetched = await services.fetcher.fetch(target.url)
        candidates = extract_candidates(fetched.text)
        old_presence = verify_fragments(fetched.text, target.fragments)
        fetch_error = None
    except FetchError as exc:
        fetched = None
        candidates = []
        old_presence = {}
        fetch_error = str(exc)
    action = "content_update" if target.content_enabled else "content_enable"
    token = services.auth.issue_operation_token(db, auth, action, target.url)
    return services.templates.TemplateResponse(
        request=request,
        name="update.html",
        context=_base(
            request,
            auth,
            title="Обновить сайт" if target.content_enabled else "Включить content-check",
            target=target,
            revision=state.revision,
            candidates=candidates,
            old_presence=old_presence,
            fetch_error=fetch_error,
            final_url=fetched.final_url if fetched else None,
            action=action,
            operation_token=token,
            error=None,
        ),
    )


@router.post("/targets/{site_id}/update", name="target_update_post")
async def target_update_post(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    try:
        current = services.repository.load_documents()
        state = services.repository.build_state(current)
        target = state.by_site_id(site_id)
        action = "content_update" if target.content_enabled else "content_enable"
        if not services.auth.consume_operation_token(db, auth, form.get("operation_token"), action, target.url):
            raise ApplyError("Форма уже была отправлена или истекла. Обновите страницу.")
        fragments = [str(value) for value in form.getlist("fragments")]
        fetched = await services.fetcher.fetch(target.url)
        missing = [fragment for fragment in fragments if fragment not in fetched.text]
        if missing:
            raise ApplyError("Один из выбранных фрагментов уже отсутствует в исходном HTML. Обновите preview.")
        if action == "content_update":
            mutate = lambda docs: services.repository.update_fragments(docs, target.url, fragments)
        else:
            mutate = lambda docs: services.repository.enable_content(docs, target.url, fragments)
        result = await services.apply.apply(
            db,
            operation=action,
            url=target.url,
            reason=str(form.get("reason", "")),
            forced=False,
            expected_revision=str(form.get("revision", "")),
            username=auth.audit_username,
            source_ip=source_ip(request),
            mutate=mutate,
            probe_kind="content",
            verify_kind="content",
        )
    except (ConfigError, FetchError, ApplyError) as exc:
        return _operation_error(request, auth, exc, 409 if isinstance(exc, ApplyError) else 422)
    params = {"message": "Изменение применено."}
    if result.notification_warning:
        params["warning"] = result.notification_warning
    return RedirectResponse(str(request.url_for("target_detail", site_id=site_id).include_query_params(**params)), status_code=303)


@router.post("/targets/{site_id}/disable-content", name="target_disable_content")
async def target_disable_content(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    try:
        state = services.repository.build_state()
        target = state.by_site_id(site_id)
        if not services.auth.consume_operation_token(db, auth, form.get("operation_token"), "content_disable", target.url):
            raise ApplyError("Форма уже была отправлена или истекла. Обновите страницу.")
        result = await services.apply.apply(
            db,
            operation="content_disable",
            url=target.url,
            reason=str(form.get("reason", "")),
            forced=False,
            expected_revision=str(form.get("revision", "")),
            username=auth.audit_username,
            source_ip=source_ip(request),
            mutate=lambda docs: services.repository.disable_content(docs, target.url),
            probe_kind="none",
            verify_kind="all",
        )
    except (ConfigError, ApplyError) as exc:
        return _operation_error(request, auth, exc, 409)
    params = {"message": "Content-check выключен; HTTP-проверка сохранена."}
    if result.notification_warning:
        params["warning"] = result.notification_warning
    return RedirectResponse(str(request.url_for("target_detail", site_id=site_id).include_query_params(**params)), status_code=303)


@router.get("/add", response_class=HTMLResponse, name="target_add_get")
async def target_add_get(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    state = request.app.state.services.repository.build_state()
    return request.app.state.services.templates.TemplateResponse(
        request=request,
        name="add.html",
        context=_base(request, auth, title="Добавить сайт", revision=state.revision),
    )


@router.post("/add/preview", response_class=HTMLResponse, name="target_add_preview")
async def target_add_preview(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    url = str(form.get("url", "")).strip()
    display_name = str(form.get("display_name", "")).strip()
    error = None
    fetched = None
    candidates = []
    try:
        validate_url(url)
        state = services.repository.build_state()
        if any(target.url == url for target in state.targets):
            raise ConfigError("Этот URL уже есть в мониторинге.")
        fetched = await services.fetcher.fetch(url)
        candidates = extract_candidates(fetched.text)
        if fetched.status_code != 200:
            error = f"Сайт вернул HTTP {fetched.status_code}. Допустимо только 200."
    except (FetchError, ConfigError) as exc:
        error = str(exc)
        state = services.repository.build_state()
    token = services.auth.issue_operation_token(db, auth, "add", url)
    return services.templates.TemplateResponse(
        request=request,
        name="partials/add_preview.html",
        context=_base(
            request,
            auth,
            url=url,
            display_name=display_name,
            revision=state.revision,
            fetched=fetched,
            candidates=candidates,
            error=error,
            operation_token=token,
        ),
        status_code=200,
    )


@router.post("/add/apply", name="target_add_apply")
async def target_add_apply(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    url = str(form.get("url", "")).strip()
    display_name = str(form.get("display_name", "")).strip() or None
    forced = form.get("forced") == "yes"
    content_enabled = form.get("content_enabled") == "yes"
    fragments = [str(value) for value in form.getlist("fragments")] if content_enabled else []
    try:
        validate_url(url)
        if not services.auth.consume_operation_token(db, auth, form.get("operation_token"), "add", url):
            raise ApplyError("Форма уже была отправлена или истекла. Выполните проверку URL повторно.")
        fetched = None
        fetch_error = None
        try:
            fetched = await services.fetcher.fetch(url)
        except FetchError as exc:
            fetch_error = exc
        if fetch_error and not forced:
            raise ApplyError(f"{fetch_error} Для сохранения требуется отдельное принудительное подтверждение.", force_required=True)
        if fetched and fetched.status_code != 200 and not forced:
            raise ApplyError(
                f"Сайт вернул HTTP {fetched.status_code}. Для сохранения требуется отдельное принудительное подтверждение.",
                force_required=True,
            )
        if fetched and fetched.final_url != url and form.get("confirm_redirect") != "yes":
            raise ApplyError("Подтвердите финальный URL после перенаправления. Исходный URL не будет изменён.")
        if content_enabled:
            if not fetched:
                raise ApplyError("Нельзя включить content-check: исходный HTML не получен.")
            if not 1 <= len(fragments) <= 3:
                raise ApplyError("Для новой цели выберите от одного до трёх фрагментов.")
            if any(fragment not in fetched.text for fragment in fragments):
                raise ApplyError("Один из выбранных фрагментов отсутствует в исходном HTML.")
        result = await services.apply.apply(
            db,
            operation="add",
            url=url,
            reason=str(form.get("reason", "")),
            forced=forced,
            expected_revision=str(form.get("revision", "")),
            username=auth.audit_username,
            source_ip=source_ip(request),
            mutate=lambda docs: services.repository.add_target(docs, url, display_name, fragments or None),
            probe_kind="content" if content_enabled else "http",
            verify_kind="content" if content_enabled else "http",
        )
    except (ConfigError, FetchError, ApplyError) as exc:
        return _operation_error(request, auth, exc, 409 if isinstance(exc, ApplyError) else 422)
    params = {"message": "Сайт добавлен в мониторинг."}
    if result.notification_warning:
        params["warning"] = result.notification_warning
    return RedirectResponse(str(request.url_for("home").include_query_params(**params)), status_code=303)


@router.get("/targets/{site_id}/delete", response_class=HTMLResponse, name="target_delete_get")
async def target_delete_get(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    try:
        state = services.repository.build_state()
        target = state.by_site_id(site_id)
    except (ConfigError, TargetNotFoundError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    token = services.auth.issue_operation_token(db, auth, "delete", target.url)
    return services.templates.TemplateResponse(
        request=request,
        name="delete.html",
        context=_base(
            request,
            auth,
            title="Удалить сайт",
            target=target,
            revision=state.revision,
            operation_token=token,
        ),
    )


@router.post("/targets/{site_id}/delete", name="target_delete_post")
async def target_delete_post(site_id: str, request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    try:
        state = services.repository.build_state()
        target = state.by_site_id(site_id)
        if str(form.get("confirm_url", "")).strip() != target.url:
            raise ApplyError("Для подтверждения введите URL цели полностью.")
        if not services.auth.consume_operation_token(db, auth, form.get("operation_token"), "delete", target.url):
            raise ApplyError("Форма уже была отправлена или истекла. Обновите страницу.")
        result = await services.apply.apply(
            db,
            operation="delete",
            url=target.url,
            reason=str(form.get("reason", "")),
            forced=False,
            expected_revision=str(form.get("revision", "")),
            username=auth.audit_username,
            source_ip=source_ip(request),
            mutate=lambda docs: services.repository.delete_target(docs, target.url),
            probe_kind="none",
            verify_kind="deleted",
        )
    except (ConfigError, ApplyError) as exc:
        return _operation_error(request, auth, exc, 409)
    params = {"message": "Цель удалена из HTTP- и content-мониторинга."}
    if result.notification_warning:
        params["warning"] = result.notification_warning
    return RedirectResponse(str(request.url_for("home").include_query_params(**params)), status_code=303)


@router.get("/history", response_class=HTMLResponse, name="history")
async def history(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    page = max(1, int(request.query_params.get("page", "1") or 1))
    url_filter = request.query_params.get("url", "").strip()
    operation_filter = request.query_params.get("operation", "").strip()
    result_filter = request.query_params.get("result", "").strip()
    statement = select(AuditEvent)
    count_statement = select(func.count(AuditEvent.id))
    conditions = []
    if url_filter:
        conditions.append(AuditEvent.url.contains(url_filter))
    if operation_filter:
        conditions.append(AuditEvent.operation == operation_filter)
    if result_filter == "success":
        conditions.append(AuditEvent.success.is_(True))
    elif result_filter == "failed":
        conditions.append(AuditEvent.success.is_(False))
    if conditions:
        statement = statement.where(*conditions)
        count_statement = count_statement.where(*conditions)
    total = int(db.scalar(count_statement) or 0)
    per_page = 20
    events = list(
        db.scalars(statement.order_by(AuditEvent.created_at.desc()).offset((page - 1) * per_page).limit(per_page))
    )
    return request.app.state.services.templates.TemplateResponse(
        request=request,
        name="history.html",
        context=_base(
            request,
            auth,
            title="История изменений",
            events=events,
            page=page,
            pages=max(1, (total + per_page - 1) // per_page),
            url_filter=url_filter,
            operation_filter=operation_filter,
            result_filter=result_filter,
        ),
    )


def _config_diff(current_state, previous_state) -> dict[str, list[Any]]:  # type: ignore[no-untyped-def]
    current = {target.url: target for target in current_state.targets}
    previous = {target.url: target for target in previous_state.targets}
    added = [previous[url] for url in sorted(previous.keys() - current.keys())]
    removed = [current[url] for url in sorted(current.keys() - previous.keys())]
    changed = [
        {"current": current[url], "previous": previous[url]}
        for url in sorted(current.keys() & previous.keys())
        if current[url].audit_dict() != previous[url].audit_dict()
    ]
    return {"restore": added, "remove": removed, "change": changed}


@router.get("/rollback", response_class=HTMLResponse, name="rollback_get")
async def rollback_get(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    current_documents = services.repository.load_documents()
    current_state = services.repository.build_state(current_documents)
    snapshot = services.backups.latest_previous()
    previous_state = None
    difference = None
    token = None
    if snapshot:
        snapshot_documents = services.repository.documents_from_rendered(services.backups.read(snapshot))
        previous_state = services.repository.build_state(snapshot_documents)
        difference = _config_diff(current_state, previous_state)
        token = services.auth.issue_operation_token(db, auth, "rollback", snapshot.name)
    return services.templates.TemplateResponse(
        request=request,
        name="rollback.html",
        context=_base(
            request,
            auth,
            title="Откатить последнюю версию",
            revision=current_state.revision,
            snapshot=snapshot,
            difference=difference,
            operation_token=token,
        ),
    )


@router.post("/rollback", name="rollback_post")
async def rollback_post(request: Request, db: Session = Depends(get_db)):
    auth = _auth_or_redirect(request, db)
    if isinstance(auth, RedirectResponse):
        return auth
    services = request.app.state.services
    form = await request.form()
    require_csrf(request, auth, form)
    snapshot_name = str(form.get("snapshot", ""))
    try:
        snapshot = next((item for item in services.backups.list() if item.name == snapshot_name), None)
        if not snapshot:
            raise ApplyError("Snapshot для отката не найден.")
        if form.get("confirm") != "yes":
            raise ApplyError("Подтвердите восстановление предыдущей версии.")
        if not services.auth.consume_operation_token(db, auth, form.get("operation_token"), "rollback", snapshot.name):
            raise ApplyError("Форма уже была отправлена или истекла. Обновите страницу.")
        snapshot_documents = services.repository.documents_from_rendered(services.backups.read(snapshot))
        result = await services.apply.apply(
            db,
            operation="rollback",
            url=None,
            reason=str(form.get("reason", "")),
            forced=False,
            expected_revision=str(form.get("revision", "")),
            username=auth.audit_username,
            source_ip=source_ip(request),
            mutate=lambda _docs: snapshot_documents.clone(),
            probe_kind="none",
            verify_kind="all",
        )
    except (ConfigError, ApplyError) as exc:
        return _operation_error(request, auth, exc, 409)
    params = {"message": "Предыдущая версия конфигурации восстановлена."}
    if result.notification_warning:
        params["warning"] = result.notification_warning
    return RedirectResponse(str(request.url_for("home").include_query_params(**params)), status_code=303)
