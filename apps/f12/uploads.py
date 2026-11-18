"""Durable, resumable ISO imports. Write a chunk to disk before acknowledging its offset."""

import contextlib
import errno
import hashlib
import http.client
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import unquote

from bootimus import DISK_RESERVE, BootError
from library import iso_name, selected_segments

MAX_FILE = 32 * 1024**3
MAX_CHUNK = 4 * 1024**2
TTL = 24 * 3600
SHA = re.compile(r"[0-9a-f]{64}\Z")


def upload_id(value):
    try:
        if isinstance(value, str) and str(uuid.UUID(value)) == value:
            return value
    except ValueError:
        pass
    raise BootError(400, "Неверный идентификатор загрузки.")


@contextlib.contextmanager
def disk_errors():
    try:
        yield
    except OSError as err:
        if err.errno in (errno.ENOSPC, errno.EDQUOT):
            raise BootError(507, "На диске закончилось место для образа.") from None
        raise
    except sqlite3.OperationalError as err:
        if getattr(err, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL:
            raise BootError(
                507, "На диске закончилось место для каталога образов."
            ) from None
        raise


class Transfers:
    def __init__(self, library, stage, segments, wait=2, clock=time.time):
        self.library = library
        self.stage = Path(stage)
        self.segments = segments
        self.lock = threading.Lock()
        self.wait = wait
        self.clock = clock
        self.workers = {}

    def initialize(self):
        self.stage.mkdir(mode=0o700, parents=True, exist_ok=True)
        for scratch in self.stage.glob("inspect-winpe-*.wim"):
            scratch.unlink(missing_ok=True)
        with self.library.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS transfer (
                    id TEXT PRIMARY KEY, actor TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
                    networks TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, updated REAL NOT NULL,
                    state TEXT NOT NULL DEFAULT 'active', result TEXT, error TEXT, code INTEGER
                );
                CREATE UNIQUE INDEX IF NOT EXISTS active_transfer ON transfer((1))
                    WHERE state IN ('active','processing','retry');
                UPDATE transfer SET state='active' WHERE state='processing';
            """)
        self.cleanup()

    def path(self, ident):
        return self.stage / (ident + ".part")

    def cleanup(self):
        with self.lock, self.library.connect() as db:
            self._expire(db)
            active = {
                r[0] + ".part"
                for r in db.execute(
                    "SELECT id FROM transfer WHERE state IN ('active','processing','retry')"
                )
            }
            for file in self.stage.glob("*.part"):
                if file.name not in active:
                    file.unlink(missing_ok=True)

    def _expire(self, db):
        expired = db.execute(
            "SELECT id FROM transfer WHERE state!='processing' AND updated<?",
            (self.clock() - TTL,),
        ).fetchall()
        for row in expired:
            self.path(row[0]).unlink(missing_ok=True)
        db.executemany("DELETE FROM transfer WHERE id=?", [(r[0],) for r in expired])

    @staticmethod
    def owned(db, ident, actor):
        row = db.execute(
            "SELECT * FROM transfer WHERE id=? AND actor=?", (ident, actor)
        ).fetchone()
        if not row:
            raise BootError(404, "Загрузка не найдена или срок её хранения истёк.")
        return row

    def pending(self, actor):
        with self.library.connect(read_only=True) as db:
            row = db.execute(
                """SELECT id,name,size,offset,state FROM transfer
                WHERE actor=? AND (state='processing' OR (state IN ('active','retry') AND updated>=?))""",
                (actor, self.clock() - TTL),
            ).fetchone()
        return dict(row) if row else None

    def start(self, actor, payload):
        ident = upload_id(payload.get("id"))
        name = iso_name(payload.get("name"))
        size = payload.get("size")
        if type(size) is not int or not 0 < size <= MAX_FILE:
            raise BootError(
                413, "Размер ISO должен быть больше нуля и не более 32 ГиБ."
            )
        networks = json.dumps(
            selected_segments(payload.get("segments"), self.segments())
        )
        with self.lock, self.library.connect() as db:
            self._expire(db)
            if db.execute("SELECT 1 FROM transfer WHERE id=?", (ident,)).fetchone():
                row = self.owned(db, ident, actor)
                if (row["name"], row["size"], row["networks"]) != (
                    name,
                    size,
                    networks,
                ):
                    raise BootError(
                        409, "Эта загрузка уже начата с другими параметрами."
                    )
                if row["state"] in ("cancelled", "failed"):
                    raise BootError(
                        row["code"] or 409, row["error"] or "Загрузка отменена."
                    )
                db.execute(
                    "UPDATE transfer SET updated=? WHERE id=?", (self.clock(), ident)
                )
                return {"id": ident, "offset": row["offset"]}
            if db.execute(
                "SELECT 1 FROM transfer WHERE state IN ('active','processing','retry')"
            ).fetchone():
                raise BootError(409, "Уже идёт загрузка или подготовка ISO.")
            if shutil.disk_usage(self.stage).free < size * 2 + DISK_RESERVE:
                raise BootError(
                    507, "Недостаточно места для временного файла и копии ISO."
                )
            db.execute(
                "INSERT INTO transfer(id,actor,name,size,networks,updated) VALUES(?,?,?,?,?,?)",
                (ident, actor, name, size, networks, self.clock()),
            )
        return {"id": ident, "offset": 0}

    def chunk(self, actor, ident, offset, digest, data):
        ident = upload_id(ident)
        if (
            type(offset) is not int
            or not 0 <= offset < MAX_FILE
            or not isinstance(digest, str)
            or not SHA.fullmatch(digest)
        ):
            raise BootError(400, "Неверные параметры части файла.")
        if not 0 < len(data) <= MAX_CHUNK:
            raise BootError(413, "Размер части должен быть от одного байта до 4 МиБ.")
        if hashlib.sha256(data).hexdigest() != digest:
            raise BootError(422, "Контрольная сумма части файла не совпала.")
        with self.lock, self.library.connect() as db, disk_errors():
            row = self.owned(db, ident, actor)
            if row["state"] in ("cancelled", "failed"):
                raise BootError(409, "Загрузка уже закрыта.")
            if offset < row["offset"]:
                # Replay checks the actual already-committed interval. Metadata stays
                # bounded even when a client chooses many small chunks.
                path = self.path(ident)
                if row["state"] == "done":
                    result = json.loads(row["result"])
                    image = db.execute(
                        "SELECT iso FROM image WHERE id=?", (result["id"],)
                    ).fetchone()
                    if not image or not image["iso"].startswith("/isos/"):
                        raise BootError(503, "Исходный образ временно недоступен.")
                    name = unquote(image["iso"][6:])
                    if iso_name(name) != name:
                        raise BootError(503, "Неверное имя сохранённого образа.")
                    path = self.library.path.parent / "isos" / name
                if offset + len(data) <= row["offset"]:
                    with path.open("rb") as stream:
                        stream.seek(offset)
                        if stream.read(len(data)) == data:
                            return {"id": ident, "offset": row["offset"]}
                raise BootError(409, "Эта часть отличается от уже принятой.")
            if (
                row["state"] != "active"
                or offset != row["offset"]
                or offset + len(data) > row["size"]
            ):
                raise BootError(
                    409, "Неверное смещение части файла. Повторите открытие загрузки."
                )
            path = self.path(ident)
            with path.open("r+b" if path.exists() else "x+b") as stream:
                if stream.seek(0, os.SEEK_END) < offset:
                    raise BootError(
                        503,
                        "Утрачена часть временного файла. Отмените загрузку и выберите ISO снова.",
                    )
                stream.seek(offset)
                stream.write(data)
                stream.truncate()
                stream.flush()
                os.fsync(stream.fileno())
            if offset == 0:
                directory = os.open(self.stage, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            db.execute(
                "UPDATE transfer SET offset=?,updated=? WHERE id=?",
                (offset + len(data), self.clock(), ident),
            )
        return {"id": ident, "offset": offset + len(data)}

    def cancel(self, actor, ident):
        ident = upload_id(ident)
        with self.lock, self.library.connect() as db:
            row = self.owned(db, ident, actor)
            if row["state"] in ("processing", "done"):
                raise BootError(409, "Образ уже передан на подготовку.")
            db.execute(
                "UPDATE transfer SET state='cancelled',updated=? WHERE id=?",
                (self.clock(), ident),
            )
            db.commit()
            self.path(ident).unlink(missing_ok=True)
        return {"id": ident, "status": "cancelled"}

    def finish(self, actor, ident):
        ident = upload_id(ident)
        with self.lock, self.library.connect() as db:
            row = self.owned(db, ident, actor)
            if row["state"] not in ("active", "processing"):
                return self._result(db, row)
            if row["offset"] != row["size"]:
                raise BootError(409, "Передача ISO ещё не завершена.")
            event = self.workers.get(ident)
            if event is None:
                event = threading.Event()
                db.execute(
                    "UPDATE transfer SET state='processing',updated=? WHERE id=?",
                    (self.clock(), ident),
                )
                db.commit()
                self.workers[ident] = event
                threading.Thread(
                    target=self._prepare,
                    args=(dict(row), event),
                    name="prepare-iso",
                    daemon=True,
                ).start()
        event.wait(self.wait)
        with self.lock, self.library.connect() as db:
            return self._result(db, self.owned(db, ident, actor))

    def _result(self, db, row):
        state = row["state"]
        if state == "done":
            return 200, json.loads(row["result"])
        if state in ("failed", "retry", "cancelled"):
            if state == "retry":
                db.execute(
                    "UPDATE transfer SET state='active' WHERE id=?", (row["id"],)
                )
                db.commit()
            raise BootError(row["code"] or 409, row["error"] or "Загрузка отменена.")
        return 202, {"id": row["id"], "offset": row["offset"], "status": "processing"}

    def _prepare(self, row, event):
        ident = row["id"]
        path = self.path(ident)

        def completed(db, result):
            db.execute(
                "UPDATE transfer SET state='done',result=?,error=NULL,code=NULL,updated=? WHERE id=?",
                (json.dumps(result, ensure_ascii=False), self.clock(), ident),
            )

        try:
            with disk_errors(), path.open("rb") as file:
                if path.stat().st_size != row["size"]:
                    raise BootError(
                        422, "Размер временного ISO не совпал с заявленным."
                    )
                digest = hashlib.file_digest(file, "sha256").hexdigest()
                file.seek(0)
                networks = selected_segments(
                    json.loads(row["networks"]), self.segments()
                )
                self.library.import_file(
                    file, row["size"], digest, row["name"], networks, completed
                )
            with self.lock:
                path.unlink(missing_ok=True)
        except (
            BootError,
            OSError,
            ValueError,
            KeyError,
            http.client.HTTPException,
            sqlite3.Error,
        ) as exc:
            status = exc.status if isinstance(exc, BootError) else 503
            message = (
                exc.message
                if isinstance(exc, BootError)
                else "Подготовка ISO временно недоступна. Повторите попытку."
            )
            logging.getLogger(__name__).warning(
                "F12 ISO preparation failed (%s)", type(exc).__name__
            )
            terminal = status < 500
            with self.library.connect() as db:
                db.execute(
                    "UPDATE transfer SET state=?,error=?,code=?,updated=? WHERE id=? AND state='processing'",
                    (
                        "failed" if terminal else "retry",
                        message,
                        status,
                        self.clock(),
                        ident,
                    ),
                )
            if terminal:
                path.unlink(missing_ok=True)
        finally:
            with self.lock:
                self.workers.pop(ident, None)
                event.set()
