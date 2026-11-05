from __future__ import annotations

import asyncio
import hmac
import stat
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerifyMismatchError


PASSWORD_HASHER = PasswordHasher(
    time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16, type=Type.ID
)
DUMMY_HASH = PASSWORD_HASHER.hash("monitoring-admin-dummy-password")


@dataclass(frozen=True, slots=True)
class Principal:
    provider: str
    subject: str
    username: str
    scopes: frozenset[str]

    def has_scope(self, scope: str) -> bool:
        return scope in self.scopes


class AuthenticationProvider(ABC):
    """Provider boundary. An OIDC provider can replace local auth without changing sessions/routes."""

    name: str

    @abstractmethod
    async def authenticate(self, username: str, password: str) -> Principal | None:
        raise NotImplementedError


class LocalFileAuthenticationProvider(AuthenticationProvider):
    name = "local"

    def __init__(self, credentials_file: Path):
        self.credentials_file = credentials_file

    def _read(self) -> tuple[str, str]:
        try:
            if stat.S_IMODE(self.credentials_file.stat().st_mode) != 0o600:
                return "", DUMMY_HASH
            raw = self.credentials_file.read_text(encoding="utf-8").strip()
        except OSError:
            return "", DUMMY_HASH
        values = {}
        for line in raw.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
        username, password_hash = values.get("username", ""), values.get("password_hash", "")
        if not username or not password_hash:
            return "", DUMMY_HASH
        if not username.strip() or not password_hash.startswith("$argon2id$"):
            return "", DUMMY_HASH
        return username.strip().lower(), password_hash.strip()

    def validate_configuration(self) -> None:
        username, password_hash = self._read()
        if not username or password_hash == DUMMY_HASH:
            raise RuntimeError("Credential secret is absent, malformed, or does not have mode 0600")

    async def authenticate(self, username: str, password: str) -> Principal | None:
        expected_username, password_hash = self._read()

        def verify() -> bool:
            try:
                password_ok = PASSWORD_HASHER.verify(password_hash, password)
            except (VerifyMismatchError, InvalidHashError):
                password_ok = False
            return hmac.compare_digest(expected_username, username.strip().lower()) and password_ok

        if not await asyncio.to_thread(verify):
            return None
        return Principal(
            provider=self.name,
            subject=expected_username,
            username=expected_username,
            scopes=frozenset({"monitoring:read", "containers:restart", "audit:read"}),
        )


class OIDCAuthenticationProvider(AuthenticationProvider):
    name = "oidc"

    async def authenticate(self, username: str, password: str) -> Principal | None:
        del username, password
        raise RuntimeError("OIDC uses an authorization-code callback, not password authentication")


def build_authentication_provider(provider_name: str, credentials_file: Path) -> AuthenticationProvider:
    if provider_name in {"local", "standalone"}:
        return LocalFileAuthenticationProvider(credentials_file)
    if provider_name == "oidc":
        raise NotImplementedError("OIDC provider is reserved by the authentication layer but is not configured in this MVP")
    raise ValueError(f"Unknown authentication provider: {provider_name}")
