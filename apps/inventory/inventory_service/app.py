"""Bounded ASGI API for inventory imports. One process and one parsing worker."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import shutil
import threading
import time
import uuid
from urllib.parse import parse_qsl
from concurrent.futures import ThreadPoolExecutor
from email import policy
from email.parser import BytesParser
from pathlib import Path

from .gateway import GatewayError, GatewayVerifier

MAX_UPLOAD = 64 * 1024 * 1024
MAX_COMMIT = 4096
MAX_JSON = 8 * 1024 * 1024
UUID_PATTERN = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
ASSETS = {"theme-init.js": "application/javascript", "platform.css": "text/css", "report.js": "application/javascript", "bootstrap.js": "application/javascript", "shared-shell.js": "application/javascript"}
EMPTY_DATASET = {key: [] for key in ("sources", "questions", "coverage", "software", "office", "windows", "licensing", "priority", "catalogPriority", "sections", "attempts", "servers", "virtualization", "developerReferences")}
EMPTY_DATASET["summary"] = {"rawMissing": 0, "directMissing": 0, "conditionalOnly": 0, "eligible": 0, "notCollected": 0, "excluded": 0}
LOG = logging.getLogger("inventory")


class APIError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def headers(scope):
    result = {}
    for key, value in scope.get("headers", []):
        key = key.decode("latin1").lower()
        if key in result:
            raise APIError("duplicate_header", "Повторяющийся заголовок запроса.")
        result[key] = value.decode("latin1")
    return result


def parse_upload(content_type, body):
    if len(content_type) > 256 or "\r" in content_type or "\n" in content_type:
        raise APIError("invalid_upload_type", "Неверный формат загрузки.")
    message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + content_type.encode("latin1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + body)
    if message.get_content_type() != "multipart/form-data" or not message.is_multipart() or message.defects:
        raise APIError("invalid_multipart", "Загрузите Excel и архив одной парой.")
    parts = {}
    for part in message.iter_parts():
        if part.is_multipart() or part.defects or len(list(part.raw_items())) > 10:
            raise APIError("invalid_multipart", "Неверная структура загрузки.")
        if any(len(part.get_all(key, [])) > 1 for key in ("Content-Disposition", "Content-Type", "Content-Transfer-Encoding")):
            raise APIError("invalid_multipart", "Повторяющиеся параметры файла.")
        if part.get_content_disposition() != "form-data":
            raise APIError("invalid_multipart", "Неверный тип поля загрузки.")
        name = part.get_param("name", header="Content-Disposition")
        filename = part.get_filename()
        if name not in {"workbook", "archive"} or name in parts or not filename:
            raise APIError("invalid_upload_parts", "Нужны ровно два файла: Excel и Source.zip.")
        if len(filename) > 255 or any(ord(c) < 32 for c in filename) or "/" in filename or "\\" in filename:
            raise APIError("invalid_filename", "Недопустимое имя файла.")
        if not filename.lower().endswith(".xlsx" if name == "workbook" else ".zip"):
            raise APIError("invalid_filename", "Выберите файл .xlsx и архив .zip.")
        if part.get("Content-Transfer-Encoding", "").lower() not in {"", "binary", "8bit"}:
            raise APIError("invalid_multipart", "Кодирование файла не поддерживается.")
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes) or not payload or len(payload) > MAX_UPLOAD:
            raise APIError("empty_upload", "Файл пуст или превышает допустимый размер.")
        parts[name] = (filename, payload)
    if set(parts) != {"workbook", "archive"}:
        raise APIError("missing_upload_part", "Выберите одновременно Excel и Source.zip.")
    fingerprint = hashlib.sha256(hashlib.sha256(parts["workbook"][1]).digest() + hashlib.sha256(parts["archive"][1]).digest()).hexdigest()
    return parts, fingerprint


def software_parameters(raw_query):
    try:
        pairs = parse_qsl(raw_query.decode("ascii"), keep_blank_values=True, strict_parsing=True, encoding="utf-8", errors="strict", max_num_fields=12)
    except (UnicodeError, ValueError):
        raise APIError("invalid_query", "Неверные параметры списка ПО.")
    allowed = {"page", "limit", "search", "branch", "category", "machine", "version", "evidence", "answer", "sort", "direction"}
    result = {}
    for key, value in pairs:
        if key not in allowed or key in result or len(value) > (200 if key == "search" else 512) or any(ord(c) < 32 for c in value):
            raise APIError("invalid_query", "Недопустимый параметр списка ПО.")
        result[key] = value
    for key, maximum, default in (("page", 1000000, "1"), ("limit", 100, "25")):
        value = result.get(key, default)
        if not re.fullmatch(r"[1-9][0-9]{0,6}", value) or int(value) > maximum:
            raise APIError("invalid_query", "Неверный размер или номер страницы.")
    if result.get("sort", "branch") not in {"branch", "machine", "product", "version", "publisher", "evidence"}:
        raise APIError("invalid_query", "Неверное поле сортировки.")
    if result.get("direction", "1") not in {"1", "-1", "asc", "desc"}:
        raise APIError("invalid_query", "Неверное направление сортировки.")
    if "direction" in result:
        result["direction"] = "-1" if result["direction"] in {"-1", "desc"} else "1"
    if result.get("evidence", "") not in {"", "missing", "conditional", "unknown", "removed", "notactivated"} or result.get("answer", "") not in {"", "yes", "no"}:
        raise APIError("invalid_query", "Неверные параметры фильтрации.")
    return result


def bootstrap_parameters(raw_query):
    try:
        if len(raw_query) > 256:
            raise ValueError
        pairs = parse_qsl(raw_query.decode("ascii"), keep_blank_values=True, strict_parsing=True, encoding="utf-8", errors="strict", max_num_fields=2)
    except (UnicodeError, ValueError):
        raise APIError("invalid_query", "Неверные параметры страницы инвентаризации.")
    result = {}
    for key, value in pairs:
        if key not in {"page", "revision"} or key in result:
            raise APIError("invalid_query", "Недопустимый параметр страницы инвентаризации.")
        result[key] = value
    page = result.get("page", "1")
    revision = result.get("revision")
    if not re.fullmatch(r"[1-9][0-9]{0,4}", page) or int(page) > 10000:
        raise APIError("invalid_query", "Неверный номер страницы инвентаризации.")
    if revision is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", revision):
        raise APIError("invalid_query", "Неверная ревизия инвентаризации.")
    if int(page) > 1 and revision is None:
        raise APIError("invalid_query", "Для следующей страницы нужна ревизия инвентаризации.")
    return int(page), revision.lower() if revision else None


class ImportJobs:
    def __init__(self, directory, importer, store, capacity=4):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.importer, self.store, self.capacity = importer, store, capacity
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="inventory-import")
        self.jobs = {}
        for path in self.directory.glob("*.json"):
            try:
                job = json.loads(path.read_text())
                if path.stem != job["job_id"] or not re.fullmatch(UUID_PATTERN, job["job_id"]):
                    raise ValueError
                if job.get("status") in {"queued", "running"}:
                    job.update(status="failed", error="import_interrupted", message="Импорт прерван перезапуском. Загрузите комплект повторно с новым ключом операции.", updated_at=time.time())
                    self._write(job)
                self.jobs[job["job_id"]] = job
            except (ValueError, KeyError, TypeError):
                LOG.error("Ignored invalid job metadata: %s", path.name)
        for directory in self.directory.glob("upload-*"):
            if directory.is_dir() and not directory.is_symlink():
                shutil.rmtree(directory)

    def _write(self, job):
        path = self.directory / (job["job_id"] + ".json")
        temporary = path.with_suffix(".json.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(job, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def submit(self, parts, fingerprint, actor, key):
        with self.lock:
            for job in self.jobs.values():
                if job["actor"] == actor and job["idempotency_key"] == key:
                    if job["fingerprint"] != fingerprint:
                        raise APIError("idempotency_conflict", "Этот ключ операции уже использован для другого комплекта.", 409)
                    return self.public(job)
            if sum(job["status"] in {"queued", "running"} for job in self.jobs.values()) >= self.capacity:
                raise APIError("import_queue_full", "Очередь импорта занята. Повторите загрузку позже.", 503)
            job_id = str(uuid.uuid4())
            folder = self.directory / ("upload-" + job_id)
            folder.mkdir(mode=0o700)
            try:
                for field, fixed_name in (("workbook", "workbook.xlsx"), ("archive", "archive.zip")):
                    path = folder / fixed_name
                    path.touch(mode=0o600)
                    path.write_bytes(parts[field][1])
                job = {"job_id": job_id, "status": "queued", "actor": actor, "idempotency_key": key, "fingerprint": fingerprint, "created_at": time.time(), "updated_at": time.time()}
                self._write(job)
                self.jobs[job_id] = job
                self.executor.submit(self._run, job_id, folder, parts["workbook"][0], parts["archive"][0])
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            return self.public(job)

    def _run(self, job_id, folder, workbook_name, archive_name):
        try:
            with self.lock:
                job = self.jobs[job_id]
                job.update(status="running", updated_at=time.time())
                self._write(job)
            parsed = self.importer.parse(folder / "workbook.xlsx", folder / "archive.zip", xlsx_name=workbook_name, archive_name=archive_name)
            result = dict(self.store.preview(parsed, job["actor"]))
            result["preview_id"] = result.get("preview_id", result.get("token"))
            with self.lock:
                job.update(status="succeeded", result=result, updated_at=time.time())
                self._write(job)
        except Exception as exc:
            LOG.error("Import job failed: %s (%s)", job_id, type(exc).__name__)
            with self.lock:
                message = ("Проверка архивов не настроена. Обратитесь к администратору установки."
                           if getattr(exc, "code", None) == "archive_password_not_configured"
                           else "Комплект не прошёл проверку. Проверьте соответствие Excel и Source.zip.")
                job.update(status="failed", error=getattr(exc, "code", "import_failed"), message=message, updated_at=time.time())
                job.pop("result", None)
                try:
                    self._write(job)
                except OSError:
                    LOG.error("Could not persist failed import status: %s", job_id)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    @staticmethod
    def public(job):
        return {key: value for key, value in job.items() if key in {"job_id", "status", "result", "error", "message", "created_at", "updated_at"}}

    def get(self, job_id, actor):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job["actor"] != actor:
                raise APIError("job_not_found", "Задача импорта не найдена.", 404)
            return self.public(job)

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=False)


class InventoryApp:
    def __init__(self, data_dir, key=None, mode="gateway", web_dir=None, importer=None, store=None, max_upload=MAX_UPLOAD, dev_origin="http://127.0.0.1:8768"):
        if mode not in {"gateway", "development"}:
            raise ValueError("Unknown inventory authentication mode")
        if importer is None:
            from .importer import Importer
            importer = Importer
        if store is None:
            from .store import Store
            store = Store(data_dir)
        self.store, self.mode, self.max_upload, self.dev_origin = store, mode, max_upload, dev_origin
        self.verifier = GatewayVerifier(key) if mode == "gateway" else None
        self.web_dir = Path(web_dir or Path(__file__).resolve().parents[1] / "web")
        self.dev_csrf = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        self.upload_slots = threading.BoundedSemaphore(2)
        self.jobs = ImportJobs(Path(data_dir) / "jobs", importer, store)

    def authenticate(self, scope, body, request_headers):
        required = "inventory:read" if scope["method"] in {"GET", "HEAD"} else "inventory:write"
        if self.mode == "gateway":
            return self.verifier.verify(scope, body, required_scope=required)
        try:
            loopback = ipaddress.ip_address(scope.get("client", ("",))[0]).is_loopback
        except ValueError:
            loopback = False
        if not loopback or any(name.startswith("x-pl-") for name in request_headers):
            raise GatewayError("development_access_denied", 403)
        if scope["method"] not in {"GET", "HEAD"}:
            if request_headers.get("origin") != self.dev_origin or not hmac.compare_digest(request_headers.get("x-csrf-token", ""), self.dev_csrf):
                raise GatewayError("invalid_gateway_csrf", 403)
        return {"sub": "local-preview", "name": "Локальный предпросмотр", "admin": False, "csrf_token": self.dev_csrf}

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                event = await receive()
                if event["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif event["type"] == "lifespan.shutdown":
                    await asyncio.to_thread(self.jobs.close)
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        admitted = False
        try:
            method, path = scope["method"], scope["path"]
            request_headers = headers(scope)
            if path == "/healthz" and method in {"GET", "HEAD"}:
                return await self.json(send, method, 200, {"status": "ok"})
            if not path.startswith("/inventory/") and path != "/inventory":
                raise APIError("not_found", "Страница не найдена.", 404)
            if method not in {"GET", "HEAD", "POST"}:
                raise APIError("method_not_allowed", "Метод не поддерживается.", 405)
            if method == "POST" and path == "/inventory/api/imports/preview":
                admitted = self.upload_slots.acquire(blocking=False)
                if not admitted:
                    raise APIError("upload_busy", "Две загрузки уже обрабатываются. Повторите позже.", 503)
            limit = self.max_upload if path == "/inventory/api/imports/preview" else MAX_COMMIT if method == "POST" else 0
            raw_length = request_headers.get("content-length", "0")
            if not re.fullmatch(r"\d{1,12}", raw_length) or int(raw_length) > limit:
                raise APIError("request_body_too_large", "Комплект превышает допустимый размер 64 МиБ.", 413)
            body = bytearray()
            while True:
                event = await receive()
                if event["type"] == "http.disconnect":
                    return
                if event["type"] != "http.request":
                    continue
                body.extend(event.get("body", b""))
                if len(body) > limit:
                    raise APIError("request_body_too_large", "Комплект превышает допустимый размер 64 МиБ.", 413)
                if not event.get("more_body", False):
                    break
            body = bytes(body)
            claims = self.authenticate(scope, body, request_headers)
            actor = claims["sub"]
            if path == "/inventory" and method in {"GET", "HEAD"}:
                return await self.respond(send, method, 308, b"", "text/plain", [(b"location", b"/inventory/")])
            if method in {"GET", "HEAD"} and path == "/inventory/api/session":
                return await self.json(send, method, 200, {"user": {"id": actor, "name": claims["name"], "admin": claims["admin"]}, "csrf_token": claims["csrf_token"]})
            if method in {"GET", "HEAD"} and path == "/inventory/api/data":
                page, revision = bootstrap_parameters(scope.get("query_string", b""))
                result = await asyncio.to_thread(self.store.bootstrap_page, page=page, revision=revision)
                result = {**result, "dataset": {**(result.get("dataset") or EMPTY_DATASET), "software": []}}
                return await self.json(send, method, 200, result)
            if method in {"GET", "HEAD"} and path == "/inventory/api/software":
                parameters = software_parameters(scope.get("query_string", b""))
                result = await asyncio.to_thread(self.store.software_page, parameters)
                return await self.json(send, method, 200, result)
            if method in {"GET", "HEAD"} and path == "/inventory/api/imports":
                return await self.json(send, method, 200, {"imports": await asyncio.to_thread(self.store.list_imports)})
            if method in {"GET", "HEAD"} and re.fullmatch(r"/inventory/api/jobs/" + UUID_PATTERN, path):
                return await self.json(send, method, 200, self.jobs.get(path.rsplit("/", 1)[1], actor))
            if method == "POST" and path == "/inventory/api/imports/preview":
                key = request_headers.get("idempotency-key", "")
                if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", key):
                    raise APIError("invalid_idempotency_key", "Нужен ключ операции импорта.")
                parts, fingerprint = await asyncio.to_thread(parse_upload, request_headers.get("content-type", ""), body)
                result = await asyncio.to_thread(self.jobs.submit, parts, fingerprint, actor, key)
                return await self.json(send, method, 202, result)
            if method == "POST" and re.fullmatch(r"/inventory/api/imports/" + UUID_PATTERN + "/commit", path):
                if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", request_headers.get("idempotency-key", "")):
                    raise APIError("invalid_idempotency_key", "Нужен ключ операции подтверждения.")
                if request_headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
                    raise APIError("invalid_json", "Нужен JSON-запрос подтверждения.")
                try:
                    if json.loads(body) != {}:
                        raise ValueError
                except (ValueError, UnicodeError):
                    raise APIError("invalid_json", "Неверный запрос подтверждения.")
                receipt = await asyncio.to_thread(self.store.commit, path.split("/")[-2], actor)
                return await self.json(send, method, 200, receipt)
            if method in {"GET", "HEAD"} and path == "/inventory/":
                return await self.respond(send, method, 200, (self.web_dir / "index.html").read_bytes(), "text/html; charset=utf-8")
            if method in {"GET", "HEAD"} and path.startswith("/inventory/static/"):
                name = path.removeprefix("/inventory/static/")
                if name in ASSETS:
                    return await self.respond(send, method, 200, (self.web_dir / name).read_bytes(), ASSETS[name] + "; charset=utf-8")
            raise APIError("not_found", "Страница не найдена.", 404)
        except GatewayError as exc:
            await self.json(send, scope.get("method", "GET"), exc.status, {"error": exc.code, "message": "Нужна действительная сессия Платформы." if exc.status == 401 else "Запрос не прошёл проверку доступа."})
        except APIError as exc:
            await self.json(send, scope.get("method", "GET"), exc.status, {"error": exc.code, "message": exc.message})
        except Exception as exc:
            code, status = getattr(exc, "code", None), getattr(exc, "status", 500)
            if code and status in {400, 403, 404, 409, 413}:
                await self.json(send, scope.get("method", "GET"), status, {"error": code, "message": "Операция отклонена. Обновите предпросмотр и проверьте комплект файлов."})
            else:
                LOG.error("Inventory request failed (%s)", type(exc).__name__)
                await self.json(send, scope.get("method", "GET"), 500, {"error": "internal_error", "message": "Не удалось выполнить операцию. Предыдущие данные сохранены."})
        finally:
            if admitted:
                self.upload_slots.release()

    @staticmethod
    async def respond(send, method, status, body, content_type, extra=None):
        response_headers = [(b"content-type", content_type.encode()), (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store"), (b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"same-origin"), (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'")]
        response_headers.extend(extra or [])
        await send({"type": "http.response.start", "status": status, "headers": response_headers})
        await send({"type": "http.response.body", "body": b"" if method == "HEAD" else body})

    @classmethod
    async def json(cls, send, method, status, value):
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        if len(payload) > MAX_JSON:
            raise APIError("response_too_large", "Ответ превышает допустимый размер. Уточните фильтры списка ПО.", 413)
        await cls.respond(send, method, status, payload, "application/json; charset=utf-8")


def create_app(data_dir=None, key=None, mode=None, web_dir=None, **kwargs):
    mode = mode or os.environ.get("INVENTORY_AUTH_MODE", "gateway")
    if mode == "gateway" and key is None:
        key = Path(os.environ.get("INVENTORY_GATEWAY_KEY_FILE", "/run/secrets/inventory-gateway.key")).read_bytes()
    return InventoryApp(data_dir or os.environ.get("INVENTORY_DATA_DIR", "/data"), key, mode, web_dir, dev_origin=os.environ.get("INVENTORY_DEV_ORIGIN", "http://127.0.0.1:8768"), **kwargs)


class _LazyApplication:
    def __init__(self):
        self.instance = None

    async def __call__(self, scope, receive, send):
        if self.instance is None:
            self.instance = create_app()
        await self.instance(scope, receive, send)


app = _LazyApplication()
