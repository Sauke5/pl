from __future__ import annotations

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from starlette.requests import Request
from starlette.responses import Response

from app.auth import service as auth_module
from app.auth.service import AuthContext, AuthService, hash_password, verify_password
from app.database import Base
from app.models import LoginAttempt, ServerSession, utcnow


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'auth.sqlite3'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session


def request_with_cookie(name: str, value: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "https",
            "server": ("monitoring.example.test", 443),
            "path": "/websites/",
            "headers": [(b"cookie", f"{name}={value}".encode())],
            "client": ("192.0.2.10", 1234),
        }
    )


def test_passwords_use_argon2id_and_plaintext_is_not_stored():
    password = "a-very-long-test-password"
    digest = hash_password(password)
    assert digest.startswith("$argon2id$")
    assert password not in digest
    assert verify_password(digest, password)
    assert not verify_password(digest, "incorrect-password")


def test_user_lifecycle_and_password_change_closes_sessions(settings, db):
    service = AuthService(settings)
    user = service.create_user(db, "operator", "a-very-long-test-password")
    response = Response()
    token = service.create_session(db, user, "192.0.2.10", response)
    assert service.get_context(db, request_with_cookie(settings.session_cookie, token)) is not None
    service.set_password(db, "operator", "another-long-test-password")
    assert service.get_context(db, request_with_cookie(settings.session_cookie, token)) is None
    assert [item.username for item in service.list_users(db)] == ["operator"]
    service.delete_user(db, "operator")
    assert service.list_users(db) == []


def test_session_cookie_flags_and_idle_expiry(settings, db):
    service = AuthService(settings)
    user = service.create_user(db, "operator", "a-very-long-test-password")
    response = Response()
    token = service.create_session(db, user, "192.0.2.10", response)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "SameSite=lax" in cookie
    assert "Path=/websites/" in cookie
    session = db.scalar(select(ServerSession))
    session.expires_at = utcnow() - timedelta(seconds=1)
    db.commit()
    assert service.get_context(db, request_with_cookie(settings.session_cookie, token)) is None


def test_csrf_and_operation_tokens_are_one_time(settings, db):
    service = AuthService(settings)
    user = service.create_user(db, "operator", "a-very-long-test-password")
    response = Response()
    token = service.create_session(db, user, "192.0.2.10", response)
    context = service.get_context(db, request_with_cookie(settings.session_cookie, token))
    assert context is not None
    assert service.verify_csrf(context, context.session.csrf_token)
    assert not service.verify_csrf(context, "wrong")
    operation_token = service.issue_operation_token(db, context, "delete", "https://example.org/")
    assert service.consume_operation_token(db, context, operation_token, "delete", "https://example.org/")
    assert not service.consume_operation_token(db, context, operation_token, "delete", "https://example.org/")


def test_operation_token_has_one_winner_across_concurrent_sessions(settings, db):
    service = AuthService(settings)
    user = service.create_user(db, "operator", "a-very-long-test-password")
    context = AuthContext(user=user, session=ServerSession(user_id=user.id, csrf_token="test"))
    token = service.issue_operation_token(db, context, "delete", "https://example.org/")
    engine = db.get_bind()
    barrier = Barrier(4)

    def consume(_):
        with Session(engine) as connection:
            barrier.wait()
            return service.consume_operation_token(connection, context, token, "delete", "https://example.org/")

    with ThreadPoolExecutor(max_workers=4) as workers:
        assert list(workers.map(consume, range(4))).count(True) == 1


@pytest.mark.asyncio
async def test_login_rate_limit_after_ten_failures(settings, db, monkeypatch):
    service = AuthService(settings)
    service.create_user(db, "operator", "a-very-long-test-password")

    async def no_sleep(_seconds):
        return None

    monkeypatch.setattr(auth_module, "verify_password", lambda *_args: False)
    monkeypatch.setattr(auth_module.asyncio, "sleep", no_sleep)
    for _ in range(10):
        assert await service.authenticate(db, "operator", "wrong", "192.0.2.10") is None
    assert await service.authenticate(db, "operator", "wrong", "192.0.2.10") is None
    assert db.scalar(select(LoginAttempt).where(LoginAttempt.source_ip == "192.0.2.10").order_by(LoginAttempt.id.desc())).id == 10
