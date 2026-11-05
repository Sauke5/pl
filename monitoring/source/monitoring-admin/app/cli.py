from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

from app.auth.providers import PASSWORD_HASHER


USERNAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")


def read_source(path: Path) -> tuple[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("Каждая строка должна иметь формат key=value")
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    username, password = values.get("username", ""), values.get("password", "")
    if not USERNAME_RE.fullmatch(username):
        raise ValueError("Некорректный username")
    if not 14 <= len(password) <= 256:
        raise ValueError("Пароль должен содержать 14–256 символов")
    return username.lower(), password


def build_secret(source: Path) -> str:
    username, password = read_source(source)
    return f"username={username}\npassword_hash={PASSWORD_HASHER.hash(password)}\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Monitoring Admin production credential secret")
    parser.add_argument("source", type=Path, help="Local user_for_admin_panel.txt")
    parser.add_argument("--output", type=Path, help="Write secret with mode 0600; otherwise print hash secret to stdout")
    args = parser.parse_args()
    try:
        content = build_secret(args.source)
        if args.output:
            flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
            descriptor = os.open(args.output, flags, 0o600)
            try:
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, content.encode("utf-8"))
            finally:
                os.close(descriptor)
        else:
            sys.stdout.write(content)
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
