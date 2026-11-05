from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from app.auth.service import AuthService
from app.config import get_settings
from app.database import SessionLocal
from app.models import User


def _password_from_prompt() -> str:
    first = getpass.getpass("Пароль: ")
    second = getpass.getpass("Повторите пароль: ")
    if first != second:
        raise ValueError("Пароли не совпадают.")
    return first


def _password_from_stdin() -> str:
    value = sys.stdin.readline().rstrip("\r\n")
    if not value:
        raise ValueError("Пустой пароль в stdin.")
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    root = parser.add_subparsers(dest="group", required=True)
    users = root.add_parser("users")
    commands = users.add_subparsers(dest="command", required=True)
    for name in ("add", "password"):
        command = commands.add_parser(name)
        command.add_argument("username")
        command.add_argument("--password-stdin", action="store_true", help=argparse.SUPPRESS)
    commands.add_parser("list")
    delete_parser = commands.add_parser("delete")
    delete_parser.add_argument("username")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    service = AuthService(get_settings())
    try:
        with SessionLocal() as db:
            if args.command == "add":
                password = _password_from_stdin() if args.password_stdin else _password_from_prompt()
                user = service.create_user(db, args.username, password)
                print(f"Создан пользователь: {user.username}")
            elif args.command == "password":
                password = _password_from_stdin() if args.password_stdin else _password_from_prompt()
                user = service.set_password(db, args.username, password)
                print(f"Пароль изменён, активные сессии закрыты: {user.username}")
            elif args.command == "list":
                for user in db.scalars(select(User).order_by(User.username)):
                    state = "active" if user.active else "disabled"
                    print(f"{user.username}\t{state}\t{user.created_at.isoformat()}")
            elif args.command == "delete":
                service.delete_user(db, args.username)
                print(f"Удалён пользователь: {args.username.strip().lower()}")
    except ValueError as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
