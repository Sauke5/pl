from __future__ import annotations

from datetime import timedelta

import pytest

from app.auth.providers import LocalFileAuthenticationProvider, build_authentication_provider
from app.auth.service import AuthService
from app.database import Base, create_database
from app.models import utcnow


@pytest.mark.asyncio
async def test_local_provider_requires_argon2_secret_mode_0600(settings):
    provider = LocalFileAuthenticationProvider(settings.credentials_file)
    provider.validate_configuration()
    principal = await provider.authenticate("admin", "correct horse battery")
    assert principal and principal.has_scope("containers:restart")
    assert await provider.authenticate("admin", "wrong") is None
    settings.credentials_file.chmod(0o644)
    with pytest.raises(RuntimeError):
        provider.validate_configuration()


def test_absolute_session_lifetime_is_enforced(settings):
    engine, factory = create_database(settings.database_url); Base.metadata.create_all(engine)
    provider = LocalFileAuthenticationProvider(settings.credentials_file); auth = AuthService(settings, provider)
    from starlette.requests import Request
    from starlette.responses import Response
    from app.auth.providers import Principal
    scope = {"type": "http", "headers": [], "client": ("127.0.0.1", 1), "method": "GET", "path": "/"}
    response = Response()
    with factory() as db:
        ctx = auth.create_session(db, Principal("local", "admin", "admin", frozenset({"monitoring:read"})), "127.0.0.1", response)
        ctx.session.created_at = utcnow() - timedelta(hours=25); db.commit()
        token = response.headers["set-cookie"].split("=", 1)[1].split(";", 1)[0]
    scope["headers"] = [(b"cookie", f"session={token}".encode())]
    with factory() as db:
        assert auth.get_context(db, Request(scope)) is None
    engine.dispose()


def test_auth_provider_factory_is_explicit(settings):
    assert isinstance(build_authentication_provider("local", settings.credentials_file), LocalFileAuthenticationProvider)
    with pytest.raises(NotImplementedError, match="OIDC"):
        build_authentication_provider("oidc", settings.credentials_file)
    with pytest.raises(ValueError, match="Unknown"):
        build_authentication_provider("ldap", settings.credentials_file)
