from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.auth.providers import AuthenticationProvider, Principal
from app.config import Settings
from app.models import Identity, LoginAttempt, ServerSession, utcnow


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def source_ip(request: Request) -> str:
    if getattr(request.state, "gateway_claims", None):
        return request.state.gateway_claims["source_ip"]
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    return (forwarded or request.headers.get("x-real-ip", "").strip() or (request.client.host if request.client else "unknown"))[:64]


@dataclass(frozen=True, slots=True)
class AuthContext:
    principal: Principal
    session: ServerSession | None
    gateway_csrf: str = ""

    @property
    def csrf_token(self) -> str:
        return self.session.csrf_token if self.session else self.gateway_csrf


class AuthService:
    def __init__(self, settings: Settings, provider: AuthenticationProvider):
        self.settings = settings
        self.provider = provider

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    async def authenticate(self, db: Session, username: str, password: str, ip: str) -> Principal | None:
        normalized = username.strip().lower()[:128]
        cutoff = utcnow() - timedelta(minutes=15)
        failures = int(db.scalar(select(func.count(LoginAttempt.id)).where(
            LoginAttempt.username == normalized, LoginAttempt.source_ip == ip,
            LoginAttempt.success.is_(False), LoginAttempt.attempted_at >= cutoff,
        )) or 0)
        if failures >= self.settings.login_rate_limit:
            await asyncio.sleep(1)
            return None
        principal = await self.provider.authenticate(normalized, password)
        db.add(LoginAttempt(username=normalized, source_ip=ip, success=principal is not None))
        db.commit()
        if principal is None:
            await asyncio.sleep(min(1.5, 0.1 * (2 ** min(failures, 4))))
        return principal

    def create_session(self, db: Session, principal: Principal, ip: str, response: Response) -> AuthContext:
        identity = db.scalar(select(Identity).where(
            Identity.provider == principal.provider, Identity.subject == principal.subject
        ))
        if identity is None:
            identity = Identity(provider=principal.provider, subject=principal.subject, username=principal.username,
                                scopes=sorted(principal.scopes), active=True)
            db.add(identity)
            db.flush()
        else:
            identity.username = principal.username
            identity.scopes = sorted(principal.scopes)
        token = secrets.token_urlsafe(48)
        now = utcnow()
        session = ServerSession(identity_id=identity.id, token_hash=self._hash(token), csrf_token=secrets.token_urlsafe(32),
                                source_ip=ip, created_at=now, last_seen_at=now,
                                expires_at=now + timedelta(seconds=self.settings.session_idle_seconds))
        db.add(session)
        db.commit()
        response.set_cookie(self.settings.session_cookie, token, max_age=self.settings.session_idle_seconds,
                            httponly=True, secure=self.settings.cookie_secure, samesite="lax",
                            path=f"{self.settings.root_path}/")
        return AuthContext(principal, session)

    def get_context(self, db: Session, request: Request) -> AuthContext | None:
        token = request.cookies.get(self.settings.session_cookie)
        if not token:
            return None
        session = db.scalar(select(ServerSession).where(ServerSession.token_hash == self._hash(token)).join(ServerSession.identity))
        now = utcnow()
        if session is None or not session.identity.active or _utc(session.expires_at) <= now:
            if session is not None:
                db.delete(session); db.commit()
            return None
        if _utc(session.created_at) + timedelta(hours=24) <= now:
            db.delete(session)
            db.commit()
            return None
        session.last_seen_at = now
        session.expires_at = now + timedelta(seconds=self.settings.session_idle_seconds)
        db.commit()
        identity = session.identity
        return AuthContext(Principal(identity.provider, identity.subject, identity.username, frozenset(identity.scopes)), session)

    def logout(self, db: Session, request: Request, response: Response) -> None:
        token = request.cookies.get(self.settings.session_cookie)
        if token:
            db.execute(delete(ServerSession).where(ServerSession.token_hash == self._hash(token))); db.commit()
        response.delete_cookie(self.settings.session_cookie, path=f"{self.settings.root_path}/")

    @staticmethod
    def csrf_ok(context: AuthContext, value: str | None) -> bool:
        return bool(value) and hmac.compare_digest(context.csrf_token, value)

    def issue_login_csrf(self, response: Response, token: str | None = None) -> str:
        token = token or secrets.token_urlsafe(32)
        response.set_cookie(self.settings.login_csrf_cookie, token, max_age=900, httponly=True,
                            secure=self.settings.cookie_secure, samesite="lax", path=f"{self.settings.root_path}/login")
        return token

    def login_csrf_ok(self, request: Request, value: str | None) -> bool:
        cookie = request.cookies.get(self.settings.login_csrf_cookie)
        return bool(cookie and value) and hmac.compare_digest(cookie, value)
