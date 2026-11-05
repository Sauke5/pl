from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Request, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import LoginAttempt, OperationToken, ServerSession, User, utcnow

logger = logging.getLogger(__name__)
USERNAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$")
password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16, type=Type.ID)
_dummy_hash = password_hasher.hash("dummy-password-never-used")


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_username(value: str) -> str:
    username = value.strip().lower()
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Логин: 3–64 символа, латиница, цифры, точка, дефис или подчёркивание.")
    return username


def validate_password(value: str) -> None:
    if len(value) < 14:
        raise ValueError("Пароль должен содержать не меньше 14 символов.")
    if len(value) > 256:
        raise ValueError("Пароль слишком длинный.")


def hash_password(value: str) -> str:
    validate_password(value)
    return password_hasher.hash(value)


def verify_password(password_hash: str, candidate: str) -> bool:
    try:
        return password_hasher.verify(password_hash, candidate)
    except (VerifyMismatchError, InvalidHashError):
        return False


def source_ip(request: Request) -> str:
    identity = getattr(request.state, "gateway_identity", None)
    if identity:
        return identity.source_ip
    forwarded = request.headers.get("x-forwarded-for", "").split(",", 1)[0].strip()
    if forwarded:
        return forwarded[:64]
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip[:64]
    return request.client.host[:64] if request.client else "unknown"


@dataclass(slots=True)
class AuthContext:
    user: User
    session: ServerSession
    identity_source: str = "standalone"
    display_name: str | None = None

    @property
    def audit_username(self) -> str:
        if self.identity_source == "platform":
            return f"{self.display_name or 'Платформа'}"[:43] + f" [{self.user.username[-16:]}]"
        return self.user.username


class AuthService:
    def __init__(self, settings: Settings):
        self.settings = settings
        if settings.auth_mode not in {"standalone", "gateway"}:
            raise ValueError("WEBSITES_ADMIN_AUTH_MODE must be standalone or gateway")

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def create_user(self, db: Session, username: str, password: str) -> User:
        username = normalize_username(username)
        if db.scalar(select(User).where(User.username == username)):
            raise ValueError("Пользователь уже существует.")
        user = User(username=username, password_hash=hash_password(password), active=True)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user

    def set_password(self, db: Session, username: str, password: str) -> User:
        username = normalize_username(username)
        user = db.scalar(select(User).where(User.username == username))
        if not user:
            raise ValueError("Пользователь не найден.")
        user.password_hash = hash_password(password)
        user.updated_at = utcnow()
        db.execute(delete(ServerSession).where(ServerSession.user_id == user.id))
        db.commit()
        return user

    def delete_user(self, db: Session, username: str) -> None:
        username = normalize_username(username)
        user = db.scalar(select(User).where(User.username == username))
        if not user:
            raise ValueError("Пользователь не найден.")
        db.delete(user)
        db.commit()

    def list_users(self, db: Session) -> list[User]:
        return list(db.scalars(select(User).order_by(User.username)))

    def failed_attempt_count(self, db: Session, username: str, ip: str) -> int:
        cutoff = utcnow() - timedelta(minutes=15)
        return int(
            db.scalar(
                select(func.count(LoginAttempt.id)).where(
                    LoginAttempt.username == username,
                    LoginAttempt.source_ip == ip,
                    LoginAttempt.success.is_(False),
                    LoginAttempt.attempted_at >= cutoff,
                )
            )
            or 0
        )

    async def authenticate(self, db: Session, username_raw: str, password: str, ip: str) -> User | None:
        try:
            username = normalize_username(username_raw)
        except ValueError:
            username = username_raw.strip().lower()[:64]

        failures = self.failed_attempt_count(db, username, ip)
        if failures >= 10:
            logger.warning("login_rate_limited", extra={"username": username, "source_ip": ip})
            await asyncio.sleep(2)
            return None

        user = db.scalar(select(User).where(User.username == username, User.active.is_(True)))
        valid = verify_password(user.password_hash if user else _dummy_hash, password)
        db.add(LoginAttempt(username=username, source_ip=ip, success=valid))
        db.commit()

        if not valid or not user:
            delay = min(2.0, 0.15 * (2 ** min(failures, 4)))
            logger.warning("login_failed", extra={"username": username, "source_ip": ip, "failures": failures + 1})
            await asyncio.sleep(delay)
            return None

        logger.info("login_success", extra={"username": username, "source_ip": ip})
        return user

    def create_session(self, db: Session, user: User, ip: str, response: Response, previous_token: str | None = None) -> str:
        if previous_token:
            db.execute(delete(ServerSession).where(ServerSession.token_hash == self._token_hash(previous_token)))
        token = secrets.token_urlsafe(48)
        now = utcnow()
        session = ServerSession(
            user_id=user.id,
            token_hash=self._token_hash(token),
            csrf_token=secrets.token_urlsafe(32),
            created_at=now,
            last_seen_at=now,
            expires_at=now + timedelta(seconds=self.settings.session_idle_seconds),
            source_ip=ip,
        )
        db.add(session)
        db.commit()
        response.set_cookie(
            self.settings.session_cookie,
            token,
            max_age=self.settings.session_idle_seconds,
            httponly=True,
            secure=self.settings.cookie_secure,
            samesite="lax",
            path=f"{self.settings.root_path}/",
        )
        return token

    def get_context(self, db: Session, request: Request) -> AuthContext | None:
        if self.settings.auth_mode == "gateway":
            identity = getattr(request.state, "gateway_identity", None)
            if identity is None:
                return None
            username = "platform:" + hashlib.sha256(identity.subject.encode()).hexdigest()[:55]
            db.execute(sqlite_insert(User).values(username=username, password_hash="!platform-only", active=True).on_conflict_do_nothing(index_elements=["username"]))
            db.commit()
            user = db.scalar(select(User).where(User.username == username))
            if not user or not user.active:
                return None
            return AuthContext(
                user=user,
                session=ServerSession(user_id=user.id, csrf_token=identity.csrf_token),
                identity_source="platform",
                display_name=identity.name,
            )
        token = request.cookies.get(self.settings.session_cookie)
        if not token:
            return None
        session = db.scalar(
            select(ServerSession).where(ServerSession.token_hash == self._token_hash(token)).join(ServerSession.user)
        )
        now = utcnow()
        if not session or not session.user.active or _as_utc(session.expires_at) <= now:
            if session:
                db.delete(session)
                db.commit()
            return None
        session.last_seen_at = now
        session.expires_at = now + timedelta(seconds=self.settings.session_idle_seconds)
        db.commit()
        return AuthContext(user=session.user, session=session)

    def logout(self, db: Session, request: Request, response: Response) -> None:
        token = request.cookies.get(self.settings.session_cookie)
        if token:
            db.execute(delete(ServerSession).where(ServerSession.token_hash == self._token_hash(token)))
            db.commit()
        response.delete_cookie(self.settings.session_cookie, path=f"{self.settings.root_path}/")

    @staticmethod
    def verify_csrf(context: AuthContext, submitted: str | None) -> bool:
        return bool(submitted) and hmac.compare_digest(context.session.csrf_token, submitted)

    @staticmethod
    def new_login_csrf() -> str:
        return secrets.token_urlsafe(32)

    def issue_login_csrf(self, response: Response, token: str) -> None:
        response.set_cookie(
            self.settings.csrf_cookie,
            token,
            max_age=900,
            httponly=True,
            secure=self.settings.cookie_secure,
            samesite="lax",
            path=f"{self.settings.root_path}/login",
        )

    def verify_login_csrf(self, request: Request, submitted: str | None) -> bool:
        cookie = request.cookies.get(self.settings.csrf_cookie)
        return bool(cookie and submitted) and hmac.compare_digest(cookie, submitted)

    def issue_operation_token(self, db: Session, context: AuthContext, action: str, target: str | None) -> str:
        token = secrets.token_urlsafe(32)
        now = utcnow()
        db.add(
            OperationToken(
                token_hash=self._token_hash(token),
                user_id=context.user.id,
                action=action,
                target=target,
                created_at=now,
                expires_at=now + timedelta(minutes=30),
            )
        )
        db.commit()
        return token

    def consume_operation_token(
        self, db: Session, context: AuthContext, token: str | None, action: str, target: str | None
    ) -> bool:
        if not token:
            return False
        now = utcnow()
        result = db.execute(
            update(OperationToken).where(
                OperationToken.token_hash == self._token_hash(token),
                OperationToken.user_id == context.user.id,
                OperationToken.action == action,
                OperationToken.target == target,
                OperationToken.used_at.is_(None),
                OperationToken.expires_at > now,
            ).values(used_at=now)
        )
        db.commit()
        return result.rowcount == 1
