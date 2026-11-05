from __future__ import annotations

from collections.abc import Generator
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def create_database(database_url: str) -> tuple[object, sessionmaker[Session]]:
    engine = create_engine(
        database_url,
        connect_args={"check_same_thread": False, "timeout": 15} if database_url.startswith("sqlite") else {},
        pool_pre_ping=True,
    )
    if database_url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def _pragmas(connection, _record):  # type: ignore[no-untyped-def]
            cursor = connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=15000")
            cursor.close()
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, class_=Session)
    return engine, factory


def session_dependency(factory: sessionmaker[Session]):
    def _get_db() -> Generator[Session, None, None]:
        with factory() as db:
            yield db
    return _get_db
