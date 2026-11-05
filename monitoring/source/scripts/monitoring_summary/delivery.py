from __future__ import annotations

import fcntl
import hashlib
import html
import logging
import os
import re
import shutil
import sqlite3
import uuid
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator

from .clients import TelegramAPIError, TelegramClient
from .config import TelegramSettings, alertmanager_telegram_settings, load_settings

LOGGER = logging.getLogger(__name__)
BACKOFF_MINUTES = (2, 5, 15, 30, 60, 180, 360)
TOKEN_RE = re.compile(r"bot\d+:[A-Za-z0-9_-]+", re.I)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def safe_error(exc: BaseException) -> str:
    return TOKEN_RE.sub("bot<redacted>", f"{type(exc).__name__}: {exc}")[:2000]


def daily_caption(report_date: date, run_id: int, branch: str | None = None) -> str:
    title = (
        f"Ежедневный отчёт по инфраструктуре филиала {branch}"
        if branch
        else "Ежедневный отчёт по IT-инфраструктуре"
    )
    return (
        f"📊 <b>{html.escape(title)}</b>\n"
        f"{report_date:%d.%m.%Y} · снимок <code>#{run_id}</code>"
    )


def weekly_caption(period_key: str, start: date, end: date) -> str:
    return (
        "📊 <b>Сводный отчёт по IT-инфраструктуре за неделю</b>\n"
        f"{start:%d.%m}–{end:%d.%m.%Y} · "
        f"неделя <code>{html.escape(period_key)}</code> · Москва"
    )


@dataclass(frozen=True)
class ReportDelivery:
    id: int
    delivery_key: str
    report_type: str
    scope: str
    period_key: str
    receiver_name: str
    original_filename: str
    spool_path: Path
    caption_html: str
    status: str
    attempt_count: int
    next_attempt_at: datetime
    created_at: datetime
    last_attempt_at: datetime | None
    sent_at: datetime | None
    telegram_message_id: int | None
    last_error: str | None


class DeliveryOutbox:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir.resolve()
        data_dir = load_settings(self.base_dir).data_dir
        self.path = data_dir / "telegram_delivery.sqlite3"
        self.spool_dir = data_dir / "telegram-outbox"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.spool_dir, 0o700)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        os.chmod(self.path, 0o600)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 30000")
        return connection

    @staticmethod
    def initialize(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS telegram_deliveries (
                id INTEGER PRIMARY KEY,
                delivery_key TEXT NOT NULL UNIQUE,
                report_type TEXT NOT NULL CHECK (report_type IN ('daily', 'weekly')),
                scope TEXT NOT NULL,
                period_key TEXT NOT NULL,
                receiver_name TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                spool_path TEXT NOT NULL,
                caption_html TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_attempt_at TEXT,
                sent_at TEXT,
                telegram_message_id INTEGER,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS telegram_deliveries_due_idx
                ON telegram_deliveries(status, next_attempt_at, created_at);
            """
        )

    @staticmethod
    def _row(row: sqlite3.Row) -> ReportDelivery:
        parse = datetime.fromisoformat
        return ReportDelivery(
            id=row["id"],
            delivery_key=row["delivery_key"],
            report_type=row["report_type"],
            scope=row["scope"],
            period_key=row["period_key"],
            receiver_name=row["receiver_name"],
            original_filename=row["original_filename"],
            spool_path=Path(row["spool_path"]),
            caption_html=row["caption_html"],
            status=row["status"],
            attempt_count=row["attempt_count"],
            next_attempt_at=parse(row["next_attempt_at"]),
            created_at=parse(row["created_at"]),
            last_attempt_at=parse(row["last_attempt_at"]) if row["last_attempt_at"] else None,
            sent_at=parse(row["sent_at"]) if row["sent_at"] else None,
            telegram_message_id=row["telegram_message_id"],
            last_error=row["last_error"],
        )

    def get(self, delivery_id: int) -> ReportDelivery | None:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            row = connection.execute(
                "SELECT * FROM telegram_deliveries WHERE id = ?",
                (delivery_id,),
            ).fetchone()
            return self._row(row) if row else None

    def enqueue(
        self,
        *,
        report_type: str,
        scope: str,
        period_key: str,
        receiver_name: str,
        report_path: Path,
        caption_html: str,
        now: datetime | None = None,
    ) -> ReportDelivery:
        with delivery_lock(self.base_dir, blocking=True) as acquired:
            if not acquired:
                raise RuntimeError("could not acquire Telegram delivery lock")
            return self._enqueue_unlocked(
                report_type=report_type,
                scope=scope,
                period_key=period_key,
                receiver_name=receiver_name,
                report_path=report_path,
                caption_html=caption_html,
                now=now,
            )

    def _enqueue_unlocked(
        self,
        *,
        report_type: str,
        scope: str,
        period_key: str,
        receiver_name: str,
        report_path: Path,
        caption_html: str,
        now: datetime | None = None,
    ) -> ReportDelivery:
        if report_type not in {"daily", "weekly"}:
            raise ValueError("report_type must be daily or weekly")
        if not scope or not period_key or not receiver_name:
            raise ValueError("scope, period_key and receiver_name are required")
        source = report_path.resolve()
        if not source.is_file():
            raise FileNotFoundError(f"report file does not exist: {source}")
        delivery_key = f"{report_type}:{scope}:{period_key}:{receiver_name}"
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            existing = connection.execute(
                "SELECT * FROM telegram_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
            if existing and existing["status"] == "sent":
                return self._row(existing)

        content_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        digest = hashlib.sha256(delivery_key.encode()).hexdigest()[:20]
        target_dir = self.spool_dir / digest
        target_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(target_dir, 0o700)
        target = target_dir / f"{content_hash[:16]}-{source.name}"
        temporary = target_dir / f".{source.name}.{uuid.uuid4().hex}.tmp"
        try:
            with source.open("rb") as src, temporary.open("wb") as dst:
                shutil.copyfileobj(src, dst)
                dst.flush()
                os.fsync(dst.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
            directory_fd = os.open(target_dir, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

        created = now or utc_now()
        timestamp = iso_utc(created)
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                """
                INSERT OR IGNORE INTO telegram_deliveries (
                    delivery_key, report_type, scope, period_key,
                    receiver_name, original_filename, spool_path,
                    caption_html, status, attempt_count, next_attempt_at,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
                """,
                (
                    delivery_key,
                    report_type,
                    scope,
                    period_key,
                    receiver_name,
                    source.name,
                    str(target),
                    caption_html,
                    timestamp,
                    timestamp,
                    timestamp,
                ),
            )
            connection.execute(
                """
                UPDATE telegram_deliveries
                SET original_filename = ?, spool_path = ?, caption_html = ?,
                    updated_at = ?
                WHERE delivery_key = ? AND status = 'pending'
                """,
                (source.name, str(target), caption_html, timestamp, delivery_key),
            )
            row = connection.execute(
                "SELECT * FROM telegram_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
            return self._row(row)

    def latest_period(self, report_type: str, scope: str = "central") -> str | None:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            row = connection.execute(
                """
                SELECT max(period_key) AS period_key
                FROM telegram_deliveries
                WHERE report_type = ? AND scope = ?
                """,
                (report_type, scope),
            ).fetchone()
            return row["period_key"]

    def due(
        self,
        *,
        now: datetime | None = None,
        limit: int = 20,
        delivery_ids: tuple[int, ...] = (),
        force: bool = False,
    ) -> list[ReportDelivery]:
        current = iso_utc(now or utc_now())
        clauses = ["status = 'pending'"]
        params: list[object] = []
        if not force:
            clauses.append("next_attempt_at <= ?")
            params.append(current)
        if delivery_ids:
            placeholders = ",".join("?" for _ in delivery_ids)
            clauses.append(f"id IN ({placeholders})")
            params.extend(delivery_ids)
        params.append(limit)
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            rows = connection.execute(
                f"""
                SELECT * FROM telegram_deliveries
                WHERE {' AND '.join(clauses)}
                ORDER BY created_at, id
                LIMIT ?
                """,
                params,
            ).fetchall()
            return [self._row(row) for row in rows]

    def mark_sent(
        self,
        delivery_id: int,
        *,
        telegram_message_id: int | None,
        now: datetime | None = None,
    ) -> None:
        timestamp = iso_utc(now or utc_now())
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                """
                UPDATE telegram_deliveries
                SET status = 'sent', attempt_count = attempt_count + 1,
                    last_attempt_at = ?, sent_at = ?, updated_at = ?,
                    telegram_message_id = ?, last_error = NULL
                WHERE id = ? AND status = 'pending'
                """,
                (timestamp, timestamp, timestamp, telegram_message_id, delivery_id),
            )

    def mark_failed(
        self,
        delivery_id: int,
        exc: BaseException,
        *,
        now: datetime | None = None,
    ) -> None:
        attempted_at = now or utc_now()
        delivery = self.get(delivery_id)
        attempts = delivery.attempt_count if delivery else 0
        retry_after: int | None = None
        if isinstance(exc, TelegramAPIError) and exc.retry_after is not None:
            try:
                retry_after = max(1, min(int(exc.retry_after), 24 * 60 * 60))
            except (TypeError, ValueError):
                retry_after = None
        delay = retry_after or BACKOFF_MINUTES[min(attempts, len(BACKOFF_MINUTES) - 1)] * 60
        next_attempt = attempted_at + timedelta(seconds=max(delay, 1))
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            connection.execute(
                """
                UPDATE telegram_deliveries
                SET status = 'pending', attempt_count = attempt_count + 1,
                    last_attempt_at = ?, next_attempt_at = ?, updated_at = ?,
                    last_error = ?
                WHERE id = ? AND status = 'pending'
                """,
                (
                    iso_utc(attempted_at),
                    iso_utc(next_attempt),
                    iso_utc(attempted_at),
                    safe_error(exc),
                    delivery_id,
                ),
            )

    def status(self) -> dict[str, object]:
        with closing(self.connect()) as connection, connection:
            self.initialize(connection)
            row = connection.execute(
                """
                SELECT
                    sum(status = 'pending') AS pending,
                    sum(status = 'sent') AS sent,
                    min(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending,
                    max(sent_at) AS last_sent_at,
                    coalesce(sum(attempt_count), 0) AS attempts
                FROM telegram_deliveries
                """
            ).fetchone()
            return {
                "pending": row["pending"] or 0,
                "sent": row["sent"] or 0,
                "oldest_pending": row["oldest_pending"],
                "last_sent_at": row["last_sent_at"],
                "attempts": row["attempts"],
            }


@contextmanager
def delivery_lock(base_dir: Path, *, blocking: bool = False) -> Iterator[bool]:
    path = load_settings(base_dir).data_dir / ".locks" / "telegram-delivery.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    acquired = False
    try:
        try:
            operation = fcntl.LOCK_EX
            if not blocking:
                operation |= fcntl.LOCK_NB
            fcntl.flock(handle.fileno(), operation)
            acquired = True
        except BlockingIOError:
            pass
        yield acquired
    finally:
        if acquired:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


TelegramFactory = Callable[[str, str, str | None], TelegramClient]


class DeliveryDispatcher:
    def __init__(
        self,
        base_dir: Path,
        *,
        telegram_factory: TelegramFactory = TelegramClient,
        now_factory: Callable[[], datetime] = utc_now,
    ):
        self.base_dir = base_dir.resolve()
        self.outbox = DeliveryOutbox(self.base_dir)
        self.telegram_factory = telegram_factory
        self.now_factory = now_factory

    def telegram_settings(self, delivery: ReportDelivery) -> TelegramSettings:
        if delivery.scope == "central" and delivery.receiver_name == "telegram-silent":
            settings = load_settings(self.base_dir)
            return TelegramSettings(
                settings.telegram_bot_token,
                settings.telegram_chat_id,
                settings.telegram_proxy_url,
            )
        expected = f"telegram-branch-{delivery.scope}-silent"
        if delivery.scope != "central" and delivery.receiver_name != expected:
            raise RuntimeError(
                f"receiver {delivery.receiver_name} does not match scope {delivery.scope}"
            )
        return alertmanager_telegram_settings(
            self.base_dir / "alertmanager/config/alertmanager.yml",
            delivery.receiver_name,
        )

    def dispatch(
        self,
        *,
        limit: int = 20,
        delivery_ids: tuple[int, ...] = (),
        force: bool = False,
    ) -> dict[str, object]:
        summary: dict[str, object] = {
            "sent": 0,
            "failed": 0,
            "skipped_locked": False,
            "errors": [],
        }
        with delivery_lock(self.base_dir) as acquired:
            if not acquired:
                summary["skipped_locked"] = True
                return summary
            deliveries = self.outbox.due(
                now=self.now_factory(),
                limit=limit,
                delivery_ids=delivery_ids,
                force=force,
            )
            for delivery in deliveries:
                try:
                    expected_hash = delivery.spool_path.name.split("-", 1)[0]
                    actual_hash = hashlib.sha256(
                        delivery.spool_path.read_bytes()
                    ).hexdigest()[:16]
                    if actual_hash != expected_hash:
                        raise RuntimeError(
                            f"spooled report checksum mismatch: {delivery.original_filename}"
                        )
                    settings = self.telegram_settings(delivery)
                    if not settings.bot_token or not settings.chat_id:
                        raise RuntimeError(
                            f"Telegram receiver {delivery.receiver_name} is incomplete"
                        )
                    response = self.telegram_factory(
                        settings.bot_token,
                        settings.chat_id,
                        settings.proxy_url,
                    ).send_document(
                        delivery.spool_path,
                        caption=delivery.caption_html,
                    )
                    response_result = response.get("result")
                    message_id = (
                        response_result.get("message_id")
                        if isinstance(response_result, dict)
                        else None
                    )
                    self.outbox.mark_sent(
                        delivery.id,
                        telegram_message_id=message_id,
                        now=self.now_factory(),
                    )
                    summary["sent"] = int(summary["sent"]) + 1
                    LOGGER.info(
                        "telegram_delivery_sent key=%s message_id=%s attempts=%s",
                        delivery.delivery_key,
                        message_id,
                        delivery.attempt_count + 1,
                    )
                except Exception as exc:
                    self.outbox.mark_failed(delivery.id, exc, now=self.now_factory())
                    error = safe_error(exc)
                    summary["failed"] = int(summary["failed"]) + 1
                    cast_errors = summary["errors"]
                    assert isinstance(cast_errors, list)
                    cast_errors.append({"delivery_key": delivery.delivery_key, "error": error})
                    LOGGER.error(
                        "telegram_delivery_failed key=%s error=%s",
                        delivery.delivery_key,
                        error,
                    )
        return summary
